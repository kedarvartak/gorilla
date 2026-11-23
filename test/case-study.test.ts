import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createCard, getCard, moveCard } from '../src/server/api/cards.js';
import { createDefaultColumns } from '../src/server/cards/defaults.js';
import { openDatabase, type DatabaseHandle } from '../src/server/db/client.js';
import { boards, columns, runs } from '../src/server/db/schema.js';
import { Dispatcher, type HaltState } from '../src/server/dispatch/dispatcher.js';
import { classifyLaunchFailure, decideRetry } from '../src/server/dispatch/retry.js';
import { PendingBindings } from '../src/server/binding/pending.js';
import { BindingResolver } from '../src/server/ingest/binding.js';
import { applyRunLifecycle } from '../src/server/ingest/lifecycle.js';
import { checkReality, rangeFor } from '../src/server/ledger/reality.js';
import { readReport, REPORT_PATH } from '../src/server/review/contract.js';
import type { LaunchResult, StreamEventPayload } from '../src/server/launcher/launcher.js';
import { configuredHookPort } from '../src/hooks/warn.js';

/**
 * Regressions for the defects the self-hosting case study found (study 1).
 * Each block names the defect it pins down.
 */

let dir: string;
let handle: DatabaseHandle;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function initRepo(path: string): void {
  mkdirSync(path, { recursive: true });
  git(path, 'init', '-q', '-b', 'main');
  git(path, 'config', 'user.email', 't@example.com');
  git(path, 'config', 'user.name', 't');
  writeFileSync(join(path, 'app.txt'), 'one\n');
  git(path, 'add', '.');
  git(path, 'commit', '-q', '-m', 'init');
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gorilla-case-study-'));
  handle = openDatabase({ path: join(dir, 'study.db') });
});

afterEach(() => {
  handle.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('defect 1: the reality check sees committed work', () => {
  it('records the HEAD a run started on, and diffs committed work from it', async () => {
    const repo = join(dir, 'repo');
    initRepo(repo);
    const start = git(repo, 'rev-parse', 'HEAD');

    const resolved = new BindingResolver(handle.sqlite).resolve('s-1', repo, null);
    const run = handle.db.select().from(runs).where(eq(runs.id, resolved.runId)).get();
    expect(run?.headShaAtStart).toBe(start);

    // The agent edits one file through a tool and another by other means, and
    // commits both - which is what dispatched agents are told to do.
    writeFileSync(join(repo, 'app.txt'), 'two\n');
    writeFileSync(join(repo, 'outside.txt'), 'never mentioned\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'work');

    const reality = await checkReality({
      cwd: repo,
      ...rangeFor([{ ...run!, cwd: repo }], repo),
      claimedPaths: ['app.txt'],
    });

    // Before the fix both lists were empty: the working tree was clean.
    expect(reality.changedFiles).toEqual(['app.txt', 'outside.txt']);
    expect(reality.changedButUnmentioned).toEqual(['outside.txt']);
  });

  it('records the HEAD a session ended on, and keeps the reason the board wrote', () => {
    const repo = join(dir, 'repo');
    initRepo(repo);
    const resolved = new BindingResolver(handle.sqlite).resolve('s-2', repo, null);
    handle.sqlite
      .prepare("UPDATE runs SET end_reason = 'completed', ended_at = 5 WHERE id = ?")
      .run(resolved.runId);

    writeFileSync(join(repo, 'app.txt'), 'three\n');
    git(repo, 'commit', '-q', '-am', 'later');

    applyRunLifecycle(handle.sqlite, {
      runId: resolved.runId,
      eventName: 'SessionEnd',
      receivedAt: 10,
      payload: { reason: 'other' },
    });

    const run = handle.db.select().from(runs).where(eq(runs.id, resolved.runId)).get();
    expect(run?.headShaAtEnd).toBe(git(repo, 'rev-parse', 'HEAD'));
    // `other` is all a stopped session reports; the board's reason is better.
    expect(run?.endReason).toBe('completed');
    expect(run?.endedAt).toBe(5);
  });

  it('bounds the range by the recorded end when looking from another checkout', () => {
    const range = rangeFor(
      [{ cwd: '/wt/card', startedAt: 1, headShaAtStart: 'aaa1111', headShaAtEnd: 'bbb2222' }],
      '/repo',
    );
    // The board's own checkout holds other cards' merges and uncommitted
    // work that is not this card's.
    expect(range).toEqual({
      headShaAtStart: 'aaa1111',
      headShaAtEnd: 'bbb2222',
      includeWorkingTree: false,
    });
  });
});

describe('defect 3: a stale report does not satisfy the completion check', () => {
  it('ignores a report written before the run started', () => {
    const path = join(dir, REPORT_PATH);
    mkdirSync(join(dir, '.gorilla'), { recursive: true });
    writeFileSync(path, JSON.stringify({ summary: 'from an earlier run' }));
    const old = new Date(Date.now() - 60_000);
    utimesSync(path, old, old);

    expect(readReport(dir)).not.toBeNull();
    expect(readReport(dir, Date.now())).toBeNull();
  });
});

/** The shape Claude Code emitted for the case study's 429s, reduced. */
function quotaEvents(resetsAtSeconds?: number): StreamEventPayload[] {
  return [
    { type: 'system', subtype: 'init', session_id: 'q' },
    {
      type: 'assistant',
      session_id: 'q',
      error: 'rate_limit',
      message: {
        content: [{ type: 'text', text: "You've hit your 5-hour limit · resets 8:30pm" }],
      },
    },
    ...(resetsAtSeconds === undefined
      ? []
      : [
          {
            type: 'rate_limit_event',
            rate_limit_info: { status: 'rejected', resetsAt: resetsAtSeconds },
          },
        ]),
    {
      type: 'result',
      subtype: 'success',
      is_error: true,
      result: "You've hit your 5-hour limit · resets 8:30pm",
      session_id: 'q',
    },
  ];
}

function failedWith(events: StreamEventPayload[], stderr = ''): LaunchResult {
  return {
    outcome: 'failed',
    exitCode: 1,
    signal: null,
    sessionId: 'q',
    events,
    retries: 0,
    stderr,
  };
}

describe('defect 4: a quota 429 in the JSON stream is classified', () => {
  it('reads the limit from the stream, with its reset time', () => {
    const verdict = classifyLaunchFailure(failedWith(quotaEvents(1795446000)));
    expect(verdict.kind).toBe('quota');
    expect(verdict.resetsAt).toBe(1795446000 * 1000);
    // Held rather than retried: retrying before the reset proves nothing.
    expect(decideRetry(verdict, 0).retry).toBe(false);
  });

  it('does not mistake the agent talking about 429s for a limit', () => {
    const events: StreamEventPayload[] = [
      {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Added a test for the 429 rate_limit path.' }] },
      },
    ];
    expect(classifyLaunchFailure(failedWith(events)).kind).toBe('stated');
  });
});

describe('the dispatcher', () => {
  const BOARD = 'board-cs';
  let dispatcher: Dispatcher;
  let halts: HaltState[];
  let ended: string[];

  function fake(script: string): string {
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

  function readyCard(title: string): string {
    const created = createCard(handle, { boardId: BOARD, title, goalCondition: 'tests pass' });
    moveCard(handle, created.id, columnNamed('Ready'), 0);
    return created.id;
  }

  beforeEach(() => {
    handle.db.insert(boards).values({ id: BOARD, name: 'b', cwd: dir, createdAt: 1 }).run();
    createDefaultColumns(handle.db, BOARD);
    halts = [];
    ended = [];
    dispatcher = new Dispatcher(handle, new PendingBindings(), {
      onHalted: (_board, halt) => halts.push(halt),
      onRunEnded: (runId) => ended.push(runId),
    });
    dispatcher.isolate = false;
  });

  afterEach(async () => {
    await dispatcher.shutdown();
  });

  it('defect 4: holds the queue on a quota refusal without failing the card', async () => {
    const lines = quotaEvents(Math.floor(Date.now() / 1000) + 3600).map(
      (event) => `echo '${JSON.stringify(event).replace(/'/g, "'\\''")}'`,
    );
    dispatcher.useExecutable(fake([...lines, 'exit 1'].join('\n')));
    const id = readyCard('hits the usage limit');

    await dispatcher.dispatch(BOARD, id)?.result;

    await vi.waitFor(() => expect(dispatcher.state(BOARD).halted?.reason).toBe('quota-exhausted'));
    const card = getCard(handle, id);
    expect(card.status).toBe('idle');
    expect(card.columnId).toBe(columnNamed('Ready'));
    expect(card.attempts).toBe(0);
    expect(dispatcher.state(BOARD).failureStreak).toBe(0);
    expect(halts[0]?.detail).toContain('resumes by itself');
  });

  it('defect 3: a retry is not finished by the previous run’s report', async () => {
    // The previous run's report, left in the checkout.
    mkdirSync(join(dir, '.gorilla'), { recursive: true });
    const stale = join(dir, REPORT_PATH);
    writeFileSync(
      stale,
      JSON.stringify({
        summary: 'Earlier run.',
        files: [],
        verification: { how: 'x', result: 'ok', evidence: null },
        outstanding: [],
      }),
    );
    const old = new Date(Date.now() - 60_000);
    utimesSync(stale, old, old);

    // This run writes nothing.
    dispatcher.useExecutable(
      fake(
        `echo '{"type":"system","subtype":"init","session_id":"sess-r"}'\necho '{"type":"result"}'`,
      ),
    );
    const id = readyCard('retried card');
    await dispatcher.dispatch(BOARD, id)?.result;

    // Judged as having no report, so the board sends it back rather than
    // settling it on the earlier run's account.
    await vi.waitFor(() => expect(getCard(handle, id).repairs).toBeGreaterThan(0));
  });

  it('defect 2 and end_reason: closes the run with its outcome and asks for extraction', async () => {
    dispatcher.useExecutable(
      fake(
        `mkdir -p .gorilla && echo '{"summary":"s","files":[],"verification":{"how":"x","result":"ok","evidence":null},"outstanding":[]}' > .gorilla/report.json\n` +
          `echo '{"type":"system","subtype":"init","session_id":"sess-e"}'\necho '{"type":"result"}'`,
      ),
    );
    const id = readyCard('ends normally');
    // The row the SessionStart hook would have created.
    handle.db
      .insert(runs)
      .values({
        id: 'run-e',
        boardId: BOARD,
        cardId: id,
        sessionId: 'sess-e',
        startedAt: 1,
        cwd: dir,
      })
      .run();

    await dispatcher.dispatch(BOARD, id)?.result;

    await vi.waitFor(() => expect(ended).toContain('run-e'));
    const run = handle.db.select().from(runs).where(eq(runs.id, 'run-e')).get();
    expect(run?.endReason).toBe('completed');
  });

  it('a retry from Needs Review puts the card back in Ready', () => {
    const id = readyCard('reviewed and sent back');
    moveCard(handle, id, columnNamed('Needs Review'), 0);

    expect(dispatcher.retry(BOARD, id, 'Remove the committed report.')).toBe(true);
    // `pump` only starts cards in Ready; idle in Needs Review never ran.
    expect(getCard(handle, id).columnId).toBe(columnNamed('Ready'));
  });
});

describe('status and doctor find the port the hooks name', () => {
  it('reads one port from the project settings', () => {
    mkdirSync(join(dir, '.claude'), { recursive: true });
    writeFileSync(
      join(dir, '.claude', 'settings.local.json'),
      JSON.stringify({
        hooks: {
          PreToolUse: [
            { hooks: [{ type: 'http', url: 'http://127.0.0.1:4377/hooks/PreToolUse' }] },
          ],
          Stop: [{ hooks: [{ type: 'http', url: 'http://127.0.0.1:4377/hooks/Stop' }] }],
        },
      }),
    );
    expect(configuredHookPort(dir)).toBe(4377);
  });

  it('gives no answer when there is nothing configured', () => {
    expect(configuredHookPort(dir)).toBeNull();
  });
});
