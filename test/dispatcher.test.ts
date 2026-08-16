import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createCard, getCard, moveCard, addDependency } from '../src/server/api/cards.js';
import { createDefaultColumns } from '../src/server/cards/defaults.js';
import { openDatabase, type DatabaseHandle } from '../src/server/db/client.js';
import { Dispatcher } from '../src/server/dispatch/dispatcher.js';
import { PendingBindings } from '../src/server/binding/pending.js';
import { boards, columns } from '../src/server/db/schema.js';

let dir: string;
let handle: DatabaseHandle;
let dispatcher: Dispatcher;
let pending: PendingBindings;

const BOARD = 'board-1';

function fakeClaude(script: string): string {
  const path = join(dir, `fake-${Math.random().toString(36).slice(2)}.sh`);
  writeFileSync(path, `#!/usr/bin/env bash\n${script}\n`, 'utf8');
  chmodSync(path, 0o755);
  return path;
}

function columnNamed(name: string): string {
  const found = handle.db.select().from(columns).where(eq(columns.name, name)).get();
  if (found === undefined) throw new Error(`no column ${name}`);
  return found.id;
}

function card(title: string, options: { goal?: string | null; ready?: boolean } = {}): string {
  const created = createCard(handle, {
    boardId: BOARD,
    title,
    goalCondition: options.goal === undefined ? '`npm test` exits 0' : options.goal,
  });

  if (options.ready !== false) {
    moveCard(handle, created.id, columnNamed('Ready'), 0);
  }
  return created.id;
}

const SUCCEEDS = `echo '{"type":"system","subtype":"init","session_id":"sess-1"}'\necho '{"type":"result"}'`;
const FAILS = `echo '{"type":"system","subtype":"init","session_id":"sess-x"}'\nexit 2`;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gorilla-dispatch-'));
  handle = openDatabase({ path: join(dir, 'dispatch.db') });

  handle.db.insert(boards).values({ id: BOARD, name: 'b', cwd: dir, createdAt: 1 }).run();
  createDefaultColumns(handle.db, BOARD);

  pending = new PendingBindings();
  dispatcher = new Dispatcher(handle, pending);
  // These exercise dispatch logic in a plain temp directory. Worktree
  // isolation has its own suite against real repositories.
  dispatcher.isolate = false;
});

afterEach(async () => {
  await dispatcher.shutdown();
  handle.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('defaults', () => {
  it('starts manual and serial', () => {
    const state = dispatcher.state(BOARD);

    // Two agents at once doubles what the operator must resynchronise with.
    expect(state.mode).toBe('manual');
    expect(state.concurrency).toBe(1);
    expect(state.halted).toBeNull();
  });

  it('does not dispatch anything while manual', async () => {
    card('waiting');
    dispatcher.useExecutable(fakeClaude(SUCCEEDS));

    expect(await dispatcher.pump(BOARD)).toEqual([]);
  });
});

describe('dispatching one card', () => {
  it('marks it running, then awaiting review when it completes', async () => {
    dispatcher.useExecutable(fakeClaude(SUCCEEDS));
    const id = card('does the work');

    const running = dispatcher.dispatch(BOARD, id);
    expect(running).not.toBeNull();
    expect(getCard(handle, id).status).toBe('running');

    await running?.result;
    await vi.waitFor(() => expect(getCard(handle, id).status).toBe('awaiting-review'));
  });

  it('moves the card into the review column', async () => {
    dispatcher.useExecutable(fakeClaude(SUCCEEDS));
    const id = card('moves on completion');

    await dispatcher.dispatch(BOARD, id)?.result;

    await vi.waitFor(() => expect(getCard(handle, id).columnId).toBe(columnNamed('Needs Review')));
  });

  it('halts after a completed run rather than pulling the next card', async () => {
    dispatcher.useExecutable(fakeClaude(SUCCEEDS));
    const id = card('first');
    card('second');

    await dispatcher.dispatch(BOARD, id)?.result;

    await vi.waitFor(() => {
      const state = dispatcher.state(BOARD);
      // A finished run is not a reviewed one, and the next card may build on it.
      expect(state.halted?.reason).toBe('awaiting-review');
      expect(state.halted?.cardTitle).toBe('first');
    });
  });

  it('refuses a card with no goal condition, and says why', async () => {
    dispatcher.useExecutable(fakeClaude(SUCCEEDS));
    const id = card('no definition of done', { goal: null });

    expect(dispatcher.dispatch(BOARD, id)).toBeNull();

    const halted = dispatcher.state(BOARD).halted;
    expect(halted?.reason).toBe('no-goal');
    expect(halted?.detail).toContain('definition of done');
  });

  it('does not dispatch the same card twice', async () => {
    dispatcher.useExecutable(fakeClaude(`sleep 5`));
    const id = card('busy');

    const first = dispatcher.dispatch(BOARD, id);
    expect(dispatcher.dispatch(BOARD, id)).toBeNull();

    first?.cancel();
    await first?.result;
  });
});

describe('halting', () => {
  it('halts on failure and names the responsible card', async () => {
    dispatcher.useExecutable(fakeClaude(FAILS));
    const id = card('breaks');

    await dispatcher.dispatch(BOARD, id)?.result;

    await vi.waitFor(() => {
      const halted = dispatcher.state(BOARD).halted;
      expect(halted?.reason).toBe('failure');
      expect(halted?.cardTitle).toBe('breaks');
    });
    expect(getCard(handle, id).status).toBe('blocked');
  });

  it('halts on cancellation and records the card as abandoned', async () => {
    dispatcher.useExecutable(fakeClaude(`echo '{"type":"system","session_id":"s"}'\nsleep 30`));
    const id = card('cancelled');

    const running = dispatcher.dispatch(BOARD, id);
    await new Promise((resolve) => setTimeout(resolve, 300));
    dispatcher.cancel(BOARD, id);
    await running?.result;

    await vi.waitFor(() => {
      expect(dispatcher.state(BOARD).halted?.reason).toBe('cancelled');
      expect(getCard(handle, id).status).toBe('abandoned');
    });
  });

  it('keeps the first halt, since later failures are consequences', async () => {
    dispatcher.useExecutable(fakeClaude(FAILS));
    const first = card('first to fail');
    const second = card('second');

    await dispatcher.dispatch(BOARD, first)?.result;
    await vi.waitFor(() => expect(dispatcher.state(BOARD).halted).not.toBeNull());

    await dispatcher.dispatch(BOARD, second)?.result;
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(dispatcher.state(BOARD).halted?.cardTitle).toBe('first to fail');
  });

  it('does not pump while halted', async () => {
    dispatcher.useExecutable(fakeClaude(FAILS));
    const id = card('breaks');
    card('never starts');

    dispatcher.setMode(BOARD, 'automatic');
    await dispatcher.dispatch(BOARD, id)?.result;
    await vi.waitFor(() => expect(dispatcher.state(BOARD).halted).not.toBeNull());

    expect(await dispatcher.pump(BOARD)).toEqual([]);
  });

  it('resumes only when the operator says so', async () => {
    dispatcher.useExecutable(fakeClaude(FAILS));
    const id = card('breaks');

    await dispatcher.dispatch(BOARD, id)?.result;
    await vi.waitFor(() => expect(dispatcher.state(BOARD).halted).not.toBeNull());

    dispatcher.setMode(BOARD, 'manual');
    expect(dispatcher.resume(BOARD).halted).toBeNull();
  });
});

describe('automatic mode', () => {
  it('respects dependency order', async () => {
    dispatcher.useExecutable(fakeClaude(SUCCEEDS));
    const blocker = card('blocker');
    const blocked = card('blocked');
    addDependency(handle, blocked, blocker);

    dispatcher.setMode(BOARD, 'automatic');
    await vi.waitFor(() => expect(getCard(handle, blocker).status).not.toBe('idle'));

    // The blocked card must not have started.
    expect(getCard(handle, blocked).status).toBe('idle');
  });

  it('runs one card at a time by default', async () => {
    dispatcher.useExecutable(fakeClaude(`echo '{"type":"system","session_id":"s"}'\nsleep 5`));
    card('a');
    card('b');
    card('c');

    dispatcher.setMode(BOARD, 'automatic');
    await vi.waitFor(() => expect(dispatcher.state(BOARD).running.length).toBe(1));

    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(dispatcher.state(BOARD).running).toHaveLength(1);
  });

  it('honours a raised concurrency limit', async () => {
    dispatcher.useExecutable(fakeClaude(`echo '{"type":"system","session_id":"s"}'\nsleep 5`));
    card('a');
    card('b');
    card('c');

    dispatcher.setConcurrency(BOARD, 2);
    dispatcher.setMode(BOARD, 'automatic');

    await vi.waitFor(() => expect(dispatcher.state(BOARD).running.length).toBe(2));
    expect(dispatcher.state(BOARD).running).toHaveLength(2);
  });

  it('refuses a concurrency below one', () => {
    expect(dispatcher.setConcurrency(BOARD, 0).concurrency).toBe(1);
  });
});

describe('shutdown', () => {
  it('cancels everything still running', async () => {
    dispatcher.useExecutable(fakeClaude(`echo '{"type":"system","session_id":"s"}'\nsleep 30`));
    const id = card('long');

    const running = dispatcher.dispatch(BOARD, id);
    await new Promise((resolve) => setTimeout(resolve, 300));

    await dispatcher.shutdown();
    expect((await running?.result)?.outcome).toBe('cancelled');
  });
});

describe('a run that achieved nothing', () => {
  it('is not reported as an ordinary completion', async () => {
    // The measured shape from the Phase 1 verification: the agent tries, every
    // call is denied, and it exits 0 having changed nothing.
    dispatcher.useExecutable(fakeClaude(SUCCEEDS));
    const id = card('refused everything');

    const run = dispatcher.dispatch(BOARD, id);
    const runRow = handle.sqlite.prepare('SELECT id FROM runs WHERE card_id = ?').get(id) as
      { id: string } | undefined;

    // Simulate three attempts with no outcome, attributed to this card.
    if (runRow === undefined) {
      handle.sqlite
        .prepare(
          'INSERT INTO runs (id, board_id, card_id, session_id, cwd, started_at) VALUES (?,?,?,?,?,?)',
        )
        .run('r-none', BOARD, id, 'sess-none', dir, Date.now());
    }
    for (let seq = 1; seq <= 3; seq += 1) {
      handle.sqlite
        .prepare(
          'INSERT INTO events (run_id, session_id, seq, event_name, received_at, payload) VALUES (?,?,?,?,?,?)',
        )
        .run(
          runRow?.id ?? 'r-none',
          'sess-none',
          seq,
          'PreToolUse',
          Date.now(),
          '{"tool_name":"Edit"}',
        );
    }

    await run?.result;

    await vi.waitFor(() => {
      const halted = dispatcher.state(BOARD).halted;
      expect(halted?.reason).toBe('no-effect');
      expect(halted?.detail).toContain('denied');
    });
  });

  it('still reports a real completion normally', async () => {
    dispatcher.useExecutable(fakeClaude(SUCCEEDS));
    const id = card('did something');

    const run = dispatcher.dispatch(BOARD, id);
    const runRow = handle.sqlite.prepare('SELECT id FROM runs WHERE card_id = ?').get(id) as
      { id: string } | undefined;

    if (runRow !== undefined) {
      for (const [seq, event] of [
        [1, 'PreToolUse'],
        [2, 'PostToolUse'],
      ] as const) {
        handle.sqlite
          .prepare(
            'INSERT INTO events (run_id, session_id, seq, event_name, received_at, payload) VALUES (?,?,?,?,?,?)',
          )
          .run(runRow.id, 'sess-ok', seq, event, Date.now(), '{"tool_name":"Edit"}');
      }
    }

    await run?.result;
    await vi.waitFor(() => expect(dispatcher.state(BOARD).halted?.reason).toBe('awaiting-review'));
  });
});

describe('launched binding', () => {
  it('registers the expectation before the child starts', () => {
    dispatcher.useExecutable(fakeClaude(`sleep 3`));
    const id = card('expects a session');

    const running = dispatcher.dispatch(BOARD, id);

    // SessionStart fires before the launcher can read the session id, so the
    // expectation has to exist by now or inference will steal the run.
    expect(pending.pendingFor(dir).map((entry) => entry.cardId)).toContain(id);

    running?.cancel();
  });
});

describe('unattended operation', () => {
  it('keeps going through completions instead of stopping at the first', async () => {
    // The overnight case. Halting on success would mean waking up to one
    // finished task and a queue that never moved.
    dispatcher.useExecutable(fakeClaude(SUCCEEDS));
    for (const title of ['a', 'b', 'c']) card(title);

    dispatcher.setPolicy(BOARD, 'unattended');
    dispatcher.setMode(BOARD, 'automatic');

    await vi.waitFor(() => expect(dispatcher.state(BOARD).completed).toHaveLength(3), {
      timeout: 10_000,
    });
    expect(dispatcher.state(BOARD).halted).toBeNull();
  });

  it('still stops on a failure, because later work would build on it', async () => {
    dispatcher.useExecutable(fakeClaude(FAILS));
    card('breaks');
    card('never runs');

    dispatcher.setPolicy(BOARD, 'unattended');
    dispatcher.setMode(BOARD, 'automatic');

    await vi.waitFor(() => expect(dispatcher.state(BOARD).halted?.reason).toBe('failure'));
  });

  it('records what finished, so the morning has somewhere to start', async () => {
    dispatcher.useExecutable(fakeClaude(SUCCEEDS));
    const id = card('finished overnight');

    dispatcher.setPolicy(BOARD, 'unattended');
    dispatcher.setMode(BOARD, 'automatic');

    await vi.waitFor(() => expect(dispatcher.state(BOARD).completed).toContain(id));
  });

  it('halts on every completion under the review policy', async () => {
    dispatcher.useExecutable(fakeClaude(SUCCEEDS));
    card('a');
    card('b');

    // The default, for when the operator is present.
    expect(dispatcher.state(BOARD).policy).toBe('review');
    dispatcher.setMode(BOARD, 'automatic');

    await vi.waitFor(() => expect(dispatcher.state(BOARD).halted?.reason).toBe('awaiting-review'));
    expect(dispatcher.state(BOARD).completed).toHaveLength(1);
  });

  it('does not start the same card twice when several finish at once', async () => {
    dispatcher.useExecutable(fakeClaude(SUCCEEDS));
    for (const title of ['a', 'b', 'c', 'd']) card(title);

    dispatcher.setConcurrency(BOARD, 3);
    dispatcher.setPolicy(BOARD, 'unattended');
    dispatcher.setMode(BOARD, 'automatic');

    await vi.waitFor(() => expect(dispatcher.state(BOARD).completed).toHaveLength(4), {
      timeout: 15_000,
    });

    // Four cards, four completions - no card ran twice.
    expect(new Set(dispatcher.state(BOARD).completed).size).toBe(4);
  });

  it('clears the completed list when the operator resumes', async () => {
    dispatcher.useExecutable(fakeClaude(SUCCEEDS));
    card('a');

    dispatcher.setMode(BOARD, 'automatic');
    await vi.waitFor(() => expect(dispatcher.state(BOARD).completed).toHaveLength(1));

    expect(dispatcher.resume(BOARD).completed).toHaveLength(0);
  });
});
