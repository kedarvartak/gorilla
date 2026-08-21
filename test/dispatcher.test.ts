import { randomUUID } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createCard,
  getCard,
  moveCard,
  addDependency,
  updateCard,
} from '../src/server/api/cards.js';
import { createDefaultColumns } from '../src/server/cards/defaults.js';
import { openDatabase, type DatabaseHandle } from '../src/server/db/client.js';
import { Dispatcher, type HaltState } from '../src/server/dispatch/dispatcher.js';
import { PendingBindings } from '../src/server/binding/pending.js';
import { boards, columns, ledgerEntries, runs } from '../src/server/db/schema.js';
import { setOperatorStatus } from '../src/server/ledger/store.js';

let dir: string;
let handle: DatabaseHandle;
let dispatcher: Dispatcher;
let halts: HaltState[];
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

/**
 * An entry nobody has judged, of the one kind that earns an interruption.
 *
 * Written straight to the ledger rather than extracted: the queue gate cares
 * that something is outstanding, not how it got there, and driving a real
 * extraction would put a model call in the middle of a dispatch test.
 */
function surprise(cardId: string, statement: string, kind: 'assumption' | 'decision'): string {
  const runId = randomUUID();
  handle.db
    .insert(runs)
    .values({
      id: runId,
      boardId: BOARD,
      cardId,
      sessionId: randomUUID(),
      startedAt: Date.now(),
      cwd: dir,
      // Null so the reality check compares nothing: this is about the ledger
      // surprise, and a commit range would add unmentioned paths of its own.
      headShaAtStart: null,
    })
    .run();

  const id = randomUUID();
  handle.db
    .insert(ledgerEntries)
    .values({
      id,
      cardId,
      runId,
      kind,
      statement,
      ...(kind === 'decision' ? { alternative: 'the other way' } : {}),
      filePaths: '[]',
      sourceEventIds: '[]',
      origin: 'model',
      createdAt: Date.now(),
    })
    .run();

  return id;
}

const SUCCEEDS = `echo '{"type":"system","subtype":"init","session_id":"sess-1"}'\necho '{"type":"result"}'`;
const FAILS = `echo '{"type":"system","subtype":"init","session_id":"sess-x"}'\nexit 2`;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gorilla-dispatch-'));
  handle = openDatabase({ path: join(dir, 'dispatch.db') });

  handle.db.insert(boards).values({ id: BOARD, name: 'b', cwd: dir, createdAt: 1 }).run();
  createDefaultColumns(handle.db, BOARD);

  pending = new PendingBindings();
  halts = [];
  dispatcher = new Dispatcher(handle, pending, {
    onHalted: (_boardId, halt) => halts.push(halt),
  });
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

  it('feeds accepted and rejected ledger judgements into the launch context', async () => {
    const captured = join(dir, 'captured-context.txt');
    // Copies whatever file --append-system-prompt-file points at, so the test
    // can read the exact context a launched run would see.
    const script = `
for ((i=1; i<=$#; i++)); do
  if [ "\${!i}" = "--append-system-prompt-file" ]; then
    j=$((i+1))
    cp "\${!j}" '${captured}'
  fi
done
${SUCCEEDS}
`;
    dispatcher.useExecutable(fakeClaude(script));
    const id = card('judged');
    const acceptedId = surprise(id, 'The schema is append-only', 'assumption');
    const rejectedId = surprise(id, 'Retry logic belongs in the client', 'assumption');
    setOperatorStatus(handle, acceptedId, 'accepted');
    setOperatorStatus(handle, rejectedId, 'rejected');

    await dispatcher.dispatch(BOARD, id)?.result;

    const context = readFileSync(captured, 'utf8');
    expect(context).toContain('The schema is append-only');
    expect(context).toContain('Retry logic belongs in the client (overruled by the operator)');
  });

  it('sends nothing for a card with no judgements', async () => {
    const captured = join(dir, 'captured-context-empty.txt');
    const script = `
for ((i=1; i<=$#; i++)); do
  if [ "\${!i}" = "--append-system-prompt-file" ]; then
    j=$((i+1))
    cp "\${!j}" '${captured}'
  fi
done
${SUCCEEDS}
`;
    dispatcher.useExecutable(fakeClaude(script));
    const id = card('unjudged');

    await dispatcher.dispatch(BOARD, id)?.result;

    const context = readFileSync(captured, 'utf8');
    expect(context).not.toContain('## Established on this card');
    expect(context).not.toContain('## Overruled by the operator');
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
  it('tells the operator, once, that the queue stopped', async () => {
    dispatcher.useExecutable(fakeClaude(FAILS));
    const id = card('breaks');

    await dispatcher.dispatch(BOARD, id)?.result;

    // A halt nobody hears about at 2am is indistinguishable from a queue that
    // ran all night. Once, though: later failures are consequences, and a
    // notifier that repeated them would train the operator to ignore it.
    await vi.waitFor(() => {
      expect(halts).toHaveLength(1);
    });
    expect(halts[0]?.cardTitle).toBe('breaks');
  });

  it('halts even when telling the operator throws', async () => {
    const shouting = new Dispatcher(handle, pending, {
      onHalted: () => {
        throw new Error('notifier exploded');
      },
    });
    shouting.isolate = false;
    shouting.useExecutable(fakeClaude(FAILS));
    const id = card('breaks anyway');

    await shouting.dispatch(BOARD, id)?.result;

    // The gate is the feature; the notification is a courtesy. A courtesy that
    // can break the gate is worse than no courtesy.
    await vi.waitFor(() => {
      expect(shouting.state(BOARD).halted?.reason).toBe('failure');
    });
    await shouting.shutdown();
  });

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

describe('the queue gate', () => {
  it('refuses to start the next card while a finished one has surprises nobody judged', async () => {
    // The 3am case. Under the unattended policy the queue used to collect
    // completions and keep going; it should keep going only while nothing is
    // waiting to be acknowledged.
    dispatcher.useExecutable(fakeClaude(SUCCEEDS));
    // Newest-first in the Ready column, so the card with the surprise is
    // created last and therefore dispatched first.
    const second = card('must not start');
    const first = card('leaves a surprise');
    surprise(first, 'The exporter is only ever called from the CLI', 'assumption');

    dispatcher.setPolicy(BOARD, 'unattended');
    dispatcher.setMode(BOARD, 'automatic');

    await vi.waitFor(() =>
      expect(dispatcher.state(BOARD).halted?.reason).toBe('unacknowledged-surprises'),
    );

    const halted = dispatcher.state(BOARD).halted;
    expect(halted?.cardId).toBe(first);
    // Names the card and how many things are outstanding, so the halt is
    // actionable without opening anything.
    expect(halted?.detail).toContain('leaves a surprise');
    expect(halted?.detail).toContain('1 surprise');

    expect(dispatcher.state(BOARD).completed).toEqual([first]);
    expect(getCard(handle, second).status).toBe('idle');
  });

  it('re-halts if the operator resumes without judging anything', async () => {
    // Otherwise the only cost of skipping the review is one extra click.
    dispatcher.useExecutable(fakeClaude(SUCCEEDS));
    card('must not start');
    const first = card('leaves a surprise');
    surprise(first, 'The migration is backwards compatible', 'assumption');

    dispatcher.setPolicy(BOARD, 'unattended');
    dispatcher.setMode(BOARD, 'automatic');
    await vi.waitFor(() =>
      expect(dispatcher.state(BOARD).halted?.reason).toBe('unacknowledged-surprises'),
    );

    dispatcher.resume(BOARD);

    await vi.waitFor(() =>
      expect(dispatcher.state(BOARD).halted?.reason).toBe('unacknowledged-surprises'),
    );
  });

  it('dispatches normally once the surprise has been acknowledged', async () => {
    dispatcher.useExecutable(fakeClaude(SUCCEEDS));
    const second = card('runs after the reading');
    const first = card('leaves a surprise');
    const entry = surprise(first, 'Nothing else reads that column', 'assumption');

    dispatcher.setPolicy(BOARD, 'unattended');
    dispatcher.setMode(BOARD, 'automatic');
    await vi.waitFor(() =>
      expect(dispatcher.state(BOARD).halted?.reason).toBe('unacknowledged-surprises'),
    );

    setOperatorStatus(handle, entry, 'accepted');
    dispatcher.resume(BOARD);

    await vi.waitFor(() => expect(dispatcher.state(BOARD).completed).toContain(second), {
      timeout: 10_000,
    });
    expect(dispatcher.state(BOARD).halted).toBeNull();
  });

  it('lets a card with nothing outstanding through', async () => {
    // A decision is real ledger content and optional reading. Widening the
    // surprise set is the one change that would undo the point of having it.
    dispatcher.useExecutable(fakeClaude(SUCCEEDS));
    const second = card('follows it');
    const first = card('ordinary work');
    surprise(first, 'Used a queue rather than a set', 'decision');

    dispatcher.setPolicy(BOARD, 'unattended');
    dispatcher.setMode(BOARD, 'automatic');

    await vi.waitFor(() => expect(dispatcher.state(BOARD).completed).toHaveLength(2), {
      timeout: 10_000,
    });
    expect(dispatcher.state(BOARD).halted).toBeNull();
    expect(dispatcher.state(BOARD).completed).toContain(second);
  });
});

describe('supervising a running card', () => {
  it('ignores events for a run it is not supervising', () => {
    // The observer runs on every hook delivery, including attached terminal
    // sessions the board never launched.
    expect(() => dispatcher.observe('no-such-run')).not.toThrow();
    expect(dispatcher.state(BOARD).halted).toBeNull();
  });

  it('never stops a card merely because the agent asked a question', () => {
    // There is no copilot mode: an overnight run has nobody awake to answer, so
    // a queue that halts on the first question has spent the night on one card.
    // Questions are recorded and read in the brief instead.
    expect(dispatcher.state(BOARD).halted).toBeNull();
    expect('autonomy' in dispatcher.state(BOARD)).toBe(false);
  });
});

describe('what the run cost', () => {
  const COSTLY = [
    `echo '{"type":"system","subtype":"init","session_id":"sess-1"}'`,
    `echo '{"type":"result","total_cost_usd":0.25,"num_turns":4,"usage":{"input_tokens":300,"output_tokens":80,"cache_read_input_tokens":5000}}'`,
  ].join('\n');

  /**
   * The run row is normally created by the hook path at SessionStart, well
   * before the launcher can read the session id out of the stream. Inserted
   * here for the same reason: the cost has nowhere to be written otherwise.
   */
  function expectRun(sessionId: string): void {
    handle.db
      .insert(runs)
      .values({
        id: randomUUID(),
        boardId: BOARD,
        sessionId,
        startedAt: Date.now(),
        cwd: dir,
      })
      .run();
  }

  function costOf(sessionId: string) {
    const row = handle.db.select().from(runs).where(eq(runs.sessionId, sessionId)).get();
    if (row === undefined) throw new Error('no run row');
    return row;
  }

  it('writes it onto the run when it settles', async () => {
    expectRun('sess-1');
    dispatcher.useExecutable(fakeClaude(COSTLY));
    const id = card('spends money');

    await dispatcher.dispatch(BOARD, id)?.result;
    await vi.waitFor(() => expect(costOf('sess-1').costSource).toBe('result'));

    const row = costOf('sess-1');
    expect(row.costUsd).toBe(0.25);
    expect(row.inputTokens).toBe(300);
    expect(row.cacheReadTokens).toBe(5000);
    expect(row.turns).toBe(4);
  });

  it('leaves the columns null when the stream reported no usage', async () => {
    expectRun('sess-1');
    dispatcher.useExecutable(fakeClaude(SUCCEEDS));
    const id = card('reports nothing');

    await dispatcher.dispatch(BOARD, id)?.result;
    await vi.waitFor(() => expect(getCard(handle, id).status).toBe('awaiting-review'));

    // Null, not zero. A run that reported nothing and a run that spent nothing
    // are different facts, and writing zero would state the second (R10).
    const row = costOf('sess-1');
    expect(row.costSource).toBeNull();
    expect(row.inputTokens).toBeNull();
  });

  it('records nothing when no run row matches the session', async () => {
    dispatcher.useExecutable(fakeClaude(COSTLY));
    const id = card('unbound session');

    // Attaching one run's bill to whatever row happened to be nearby is worse
    // than recording no bill, so this settles quietly rather than guessing.
    await dispatcher.dispatch(BOARD, id)?.result;
    await vi.waitFor(() => expect(getCard(handle, id).status).toBe('awaiting-review'));

    expect(handle.db.select().from(runs).all()).toHaveLength(0);
  });
});

describe('the token ceiling', () => {
  /** Two assistant messages, then a long sleep so the cancel has something to stop. */
  const SPENDS = [
    `echo '{"type":"system","subtype":"init","session_id":"sess-1"}'`,
    `echo '{"type":"assistant","message":{"usage":{"input_tokens":400,"output_tokens":100}}}'`,
    `echo '{"type":"assistant","message":{"usage":{"input_tokens":400,"output_tokens":100}}}'`,
    `sleep 30`,
  ].join('\n');

  function ceiling(cardId: string, tokens: number | null): void {
    updateCard(handle, cardId, { tokenCeiling: tokens });
  }

  it('stops a run that passes it', async () => {
    dispatcher.useExecutable(fakeClaude(SPENDS));
    const id = card('spends past the line');
    ceiling(id, 600);

    await dispatcher.dispatch(BOARD, id)?.result;
    await vi.waitFor(() => expect(halts.at(-1)?.reason).toBe('over-budget'));

    // Blocked, not abandoned. The work is on the branch and there is a stated
    // reason it stopped; abandoned would say the operator walked away from it.
    expect(getCard(handle, id).status).toBe('blocked');
    expect(halts.at(-1)?.detail).toContain('600');
  });

  it('names what it had spent, not only the limit', async () => {
    dispatcher.useExecutable(fakeClaude(SPENDS));
    const id = card('reports the overspend');
    ceiling(id, 600);

    await dispatcher.dispatch(BOARD, id)?.result;
    await vi.waitFor(() => expect(halts.at(-1)?.reason).toBe('over-budget'));

    // An operator who can see only the limit cannot tell a small overshoot
    // from a runaway, and those call for different responses.
    expect(halts.at(-1)?.detail).toContain('1000');
  });

  it('leaves a run alone when it has no ceiling', async () => {
    dispatcher.useExecutable(fakeClaude(SPENDS.replace('sleep 30', `echo '{"type":"result"}'`)));
    const id = card('unlimited');

    await dispatcher.dispatch(BOARD, id)?.result;
    await vi.waitFor(() => expect(getCard(handle, id).status).toBe('awaiting-review'));

    expect(halts.map((halt) => halt.reason)).not.toContain('over-budget');
  });

  it('leaves a run alone when it stays under', async () => {
    dispatcher.useExecutable(fakeClaude(SPENDS.replace('sleep 30', `echo '{"type":"result"}'`)));
    const id = card('frugal');
    ceiling(id, 10_000);

    await dispatcher.dispatch(BOARD, id)?.result;
    await vi.waitFor(() => expect(getCard(handle, id).status).toBe('awaiting-review'));

    expect(halts.map((halt) => halt.reason)).not.toContain('over-budget');
  });

  it('still calls an operator cancel a cancel', async () => {
    dispatcher.useExecutable(fakeClaude(`echo '{"type":"system","session_id":"s"}'\nsleep 30`));
    const id = card('cancelled by hand');
    ceiling(id, 10_000);

    const running = dispatcher.dispatch(BOARD, id);
    dispatcher.cancel(BOARD, id);
    await running?.result;

    // Both paths are SIGTERM and both come back as 'cancelled'. Telling the
    // operator they overspent when they pressed cancel would be a lie about
    // what happened (R10).
    await vi.waitFor(() => expect(halts.at(-1)?.reason).toBe('cancelled'));
    expect(getCard(handle, id).status).toBe('abandoned');
  });

  it('refuses a ceiling of zero rather than reading it as none', () => {
    const id = card('zero');

    // Zero would stop every run on its first message, which reads as the board
    // being broken rather than as a limit being enforced.
    expect(() => updateCard(handle, id, { tokenCeiling: 0 })).toThrow(/positive whole number/);
    expect(() => updateCard(handle, id, { tokenCeiling: -5 })).toThrow(/positive whole number/);
    expect(updateCard(handle, id, { tokenCeiling: null }).tokenCeiling).toBeNull();
  });
});
