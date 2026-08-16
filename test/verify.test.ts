import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createCard, getCard, moveCard } from '../src/server/api/cards.js';
import { createDefaultColumns } from '../src/server/cards/defaults.js';
import { openDatabase, type DatabaseHandle } from '../src/server/db/client.js';
import { Dispatcher } from '../src/server/dispatch/dispatcher.js';
import { PendingBindings } from '../src/server/binding/pending.js';
import { describeVerify, runVerify } from '../src/server/verify/run.js';
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

const DID_WORK = `echo '{"type":"system","subtype":"init","session_id":"sess-v"}'\necho '{"type":"result"}'`;

function columnNamed(name: string): string {
  const found = handle.db.select().from(columns).where(eq(columns.name, name)).get();
  if (found === undefined) throw new Error(`no column ${name}`);
  return found.id;
}

/** A card plus the tool events that prove it did something. */
function workedCard(title: string, verify: string | null): string {
  const created = createCard(handle, {
    boardId: BOARD,
    title,
    goalCondition: '`npm test` exits 0',
    guardrails: verify === null ? {} : { verify },
  });
  moveCard(handle, created.id, columnNamed('Ready'), 0);
  return created.id;
}

function recordEffect(cardId: string): void {
  handle.sqlite
    .prepare(
      'INSERT INTO runs (id, board_id, card_id, session_id, cwd, started_at) VALUES (?,?,?,?,?,?)',
    )
    .run(`run-${cardId}`, BOARD, cardId, `sess-${cardId}`, dir, Date.now());

  for (const [seq, event] of [
    [1, 'PreToolUse'],
    [2, 'PostToolUse'],
  ] as const) {
    handle.sqlite
      .prepare(
        'INSERT INTO events (run_id, session_id, seq, event_name, received_at, payload) VALUES (?,?,?,?,?,?)',
      )
      .run(`run-${cardId}`, `sess-${cardId}`, seq, event, Date.now(), '{"tool_name":"Edit"}');
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gorilla-verify-'));
  handle = openDatabase({ path: join(dir, 'verify.db') });
  handle.db.insert(boards).values({ id: BOARD, name: 'b', cwd: dir, createdAt: 1 }).run();
  createDefaultColumns(handle.db, BOARD);

  pending = new PendingBindings();
  dispatcher = new Dispatcher(handle, pending);
});

afterEach(async () => {
  await dispatcher.shutdown();
  handle.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('runVerify', () => {
  it('passes on exit 0 and keeps the output', async () => {
    const result = await runVerify({ command: 'echo all good', cwd: dir });

    expect(result.status).toBe('passed');
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('all good');
  });

  it('fails on a non-zero exit, which is the command doing its job', async () => {
    const result = await runVerify({ command: 'echo boom >&2; exit 3', cwd: dir });

    expect(result.status).toBe('failed');
    expect(result.exitCode).toBe(3);
    expect(result.output).toContain('boom');
  });

  it('distinguishes a broken check from a failing one', async () => {
    // The operator must not read "the command does not exist" as "the tests
    // failed" - the first means nothing was verified at all.
    const result = await runVerify({ command: 'definitely-not-a-real-binary', cwd: dir });

    expect(result.status).toBe('failed');
    expect(describeVerify({ ...result, status: 'errored' })).toContain('could not run');
  });

  it('errors rather than throwing when the directory is gone', async () => {
    const result = await runVerify({ command: 'true', cwd: join(dir, 'absent') });

    expect(result.status).toBe('errored');
    expect(result.output).toContain('does not exist');
  });

  it('runs through a shell, because that is how the command was written', async () => {
    const result = await runVerify({ command: 'echo one && echo two | tr a-z A-Z', cwd: dir });

    expect(result.status).toBe('passed');
    expect(result.output).toContain('TWO');
  });

  it('runs in the directory it was given', async () => {
    const inner = join(dir, 'inner');
    mkdirSync(inner, { recursive: true });
    writeFileSync(join(inner, 'marker.txt'), 'here');

    expect((await runVerify({ command: 'cat marker.txt', cwd: inner })).output).toContain('here');
  });

  it('reports a timeout as errored rather than failed', async () => {
    const result = await runVerify({ command: 'sleep 5', cwd: dir, timeoutMs: 300 });

    expect(result.status).toBe('errored');
    expect(result.output).toContain('timed out');
  });

  it('skips when no command is set', async () => {
    expect((await runVerify({ command: '   ', cwd: dir })).status).toBe('skipped');
  });
});

describe('the verify gate', () => {
  it('runs the card verify command and passes', async () => {
    dispatcher.useExecutable(fakeClaude(DID_WORK));
    const id = workedCard('passes its tests', 'exit 0');

    const run = dispatcher.dispatch(BOARD, id);
    recordEffect(id);
    await run?.result;

    await vi.waitFor(() => {
      expect(dispatcher.verifyResultFor(id)?.status).toBe('passed');
      expect(dispatcher.state(BOARD).halted?.reason).toBe('awaiting-review');
    });
  });

  it('halts with verify-failed when the command does not pass', async () => {
    dispatcher.useExecutable(fakeClaude(DID_WORK));
    const id = workedCard('breaks the tests', 'echo 2 failures >&2; exit 1');

    const run = dispatcher.dispatch(BOARD, id);
    recordEffect(id);
    await run?.result;

    await vi.waitFor(() => {
      const halted = dispatcher.state(BOARD).halted;
      // The agent said it finished. The board checked, and it had not.
      expect(halted?.reason).toBe('verify-failed');
      expect(halted?.detail).toContain('FAILED');
    });

    expect(dispatcher.verifyResultFor(id)?.output).toContain('2 failures');
    // Not marked done: it goes to review with the output attached.
    expect(getCard(handle, id).status).toBe('awaiting-review');
  });

  it('is skipped, not failed, when the card sets no verify command', async () => {
    dispatcher.useExecutable(fakeClaude(DID_WORK));
    const id = workedCard('no verify', null);

    const run = dispatcher.dispatch(BOARD, id);
    recordEffect(id);
    await run?.result;

    await vi.waitFor(() => expect(dispatcher.state(BOARD).halted?.reason).toBe('awaiting-review'));
    expect(dispatcher.verifyResultFor(id)).toBeUndefined();
  });

  it('does not run verify for a run that achieved nothing', async () => {
    // No point checking the tests when the agent was refused every tool call;
    // the no-effect halt is the more useful thing to say.
    dispatcher.useExecutable(fakeClaude(DID_WORK));
    const id = workedCard('denied everything', 'exit 0');

    handle.sqlite
      .prepare(
        'INSERT INTO runs (id, board_id, card_id, session_id, cwd, started_at) VALUES (?,?,?,?,?,?)',
      )
      .run('run-none', BOARD, id, 'sess-none', dir, Date.now());
    handle.sqlite
      .prepare(
        'INSERT INTO events (run_id, session_id, seq, event_name, received_at, payload) VALUES (?,?,?,?,?,?)',
      )
      .run('run-none', 'sess-none', 1, 'PreToolUse', Date.now(), '{"tool_name":"Edit"}');

    const run = dispatcher.dispatch(BOARD, id);
    await run?.result;

    await vi.waitFor(() => expect(dispatcher.state(BOARD).halted?.reason).toBe('no-effect'));
    expect(dispatcher.verifyResultFor(id)).toBeUndefined();
  });

  it('runs verify where the work happened, not where the board lives', async () => {
    // U2 gives each card a worktree; the gate must follow the work there.
    const worktree = join(dir, 'worktree');
    mkdirSync(worktree, { recursive: true });
    writeFileSync(join(worktree, 'only-here.txt'), 'yes');

    dispatcher.workspaceFor = () => worktree;
    dispatcher.useExecutable(fakeClaude(DID_WORK));
    const id = workedCard('checks in its worktree', 'cat only-here.txt');

    const run = dispatcher.dispatch(BOARD, id);
    recordEffect(id);
    await run?.result;

    await vi.waitFor(() => {
      const result = dispatcher.verifyResultFor(id);
      expect(result?.status).toBe('passed');
      expect(result?.cwd).toBe(worktree);
    });
  });
});
