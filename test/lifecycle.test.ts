import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '../src/server/app.js';
import { openDatabase, type DatabaseHandle } from '../src/server/db/client.js';
import {
  describeReconcile,
  INTERRUPTED,
  reconcileOpenRuns,
} from '../src/server/ingest/lifecycle.js';

/**
 * Closing a run.
 *
 * `SessionEnd` was stored as an event and never applied to the run, so every run
 * the board had recorded read "in progress" forever - the interface asserting a
 * live session for one that exited a day earlier. These tests exist because that
 * is the stale-signal failure the product is supposed to remove, not cause.
 */

let dir: string;
let database: DatabaseHandle;
let app: FastifyInstance;

async function hook(
  event: string,
  sessionId: string,
  payload: Record<string, unknown> = {},
): Promise<void> {
  await app.inject({
    method: 'POST',
    url: `/hooks/${event}`,
    payload: { session_id: sessionId, cwd: dir, hook_event_name: event, ...payload },
  });
}

function runFor(sessionId: string): {
  id: string;
  ended_at: number | null;
  end_reason: string | null;
  started_at: number;
} {
  return database.sqlite
    .prepare('SELECT id, ended_at, end_reason, started_at FROM runs WHERE session_id = ?')
    .get(sessionId) as never;
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'gorilla-lifecycle-'));
  database = openDatabase({ path: join(dir, 'lifecycle.db') });
  app = buildApp({ database, logger: false });
  await app.ready();

  await app.inject({
    method: 'POST',
    url: '/api/boards',
    payload: { name: 'test', cwd: dir },
  });
});

afterEach(async () => {
  await app.close();
  database.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('closing a run from its own events', () => {
  it('records the end when SessionEnd arrives', async () => {
    await hook('SessionStart', 's1', { source: 'startup' });
    expect(runFor('s1').ended_at).toBeNull();

    await hook('SessionEnd', 's1', { reason: 'clear' });

    const run = runFor('s1');
    expect(run.ended_at).not.toBeNull();
    expect(run.end_reason).toBe('clear');
  });

  it('keeps a reason even when the payload gives none', async () => {
    await hook('SessionStart', 's1', { source: 'startup' });
    await hook('SessionEnd', 's1');

    expect(runFor('s1').end_reason).toBe('session ended');
  });

  it('leaves an ordinary event alone', async () => {
    await hook('SessionStart', 's1', { source: 'startup' });
    await hook('PostToolUse', 's1', { tool_name: 'Edit' });

    expect(runFor('s1').ended_at).toBeNull();
  });

  it('does not resurrect a run on a late-delivered event', async () => {
    await hook('SessionStart', 's1', { source: 'startup' });
    await hook('SessionEnd', 's1', { reason: 'exit' });
    const closedAt = runFor('s1').ended_at;

    // Out-of-order delivery is expected (doc 06); it is not evidence of life.
    await hook('PostToolUse', 's1', { tool_name: 'Edit' });

    expect(runFor('s1').ended_at).toBe(closedAt);
    expect(runFor('s1').end_reason).toBe('exit');
  });
});

describe('reconciling on startup', () => {
  it('closes a run the board never saw end, and says the time is a guess', async () => {
    await hook('SessionStart', 's1', { source: 'startup' });
    await hook('PostToolUse', 's1', { tool_name: 'Edit' });

    const result = reconcileOpenRuns(database.sqlite);

    expect(result.interrupted).toBe(1);
    expect(result.backfilled).toBe(0);
    const run = runFor('s1');
    expect(run.end_reason).toBe(INTERRUPTED);
    expect(run.ended_at).not.toBeNull();
  });

  it('uses the last event as the end, never the moment of restart', async () => {
    await hook('SessionStart', 's1', { source: 'startup' });
    await hook('PostToolUse', 's1', { tool_name: 'Edit' });

    const lastEvent = database.sqlite
      .prepare('SELECT MAX(received_at) AS at FROM events WHERE session_id = ?')
      .get('s1') as { at: number };

    reconcileOpenRuns(database.sqlite);

    // Claiming the run lasted until this morning's restart would be a
    // fabricated duration, which is worse than an approximate one.
    expect(runFor('s1').ended_at).toBe(lastEvent.at);
  });

  it('backfills a SessionEnd that was received but never applied', async () => {
    await hook('SessionStart', 's1', { source: 'startup' });
    await hook('SessionEnd', 's1', { reason: 'logout' });

    // Exactly the state every pre-existing run was left in.
    database.sqlite.prepare('UPDATE runs SET ended_at = NULL, end_reason = NULL').run();

    const result = reconcileOpenRuns(database.sqlite);

    expect(result.backfilled).toBe(1);
    expect(result.interrupted).toBe(0);
    expect(runFor('s1').end_reason).toBe('logout');
  });

  it('closes a run that produced no events at all', async () => {
    await hook('SessionStart', 's1', { source: 'startup' });
    const started = runFor('s1').started_at;
    database.sqlite.prepare('DELETE FROM events').run();
    database.sqlite.prepare('UPDATE runs SET ended_at = NULL, end_reason = NULL').run();

    reconcileOpenRuns(database.sqlite);

    expect(runFor('s1').ended_at).toBe(started);
  });

  it('leaves an already-closed run untouched', async () => {
    await hook('SessionStart', 's1', { source: 'startup' });
    await hook('SessionEnd', 's1', { reason: 'exit' });
    const closedAt = runFor('s1').ended_at;

    expect(reconcileOpenRuns(database.sqlite)).toEqual({ backfilled: 0, interrupted: 0 });
    expect(runFor('s1').ended_at).toBe(closedAt);
  });

  it('reopens an interrupted run if the session turns out to be alive', async () => {
    await hook('SessionStart', 's1', { source: 'startup' });
    reconcileOpenRuns(database.sqlite);
    expect(runFor('s1').end_reason).toBe(INTERRUPTED);

    // An attached terminal session can outlive a board restart, and the guess
    // that it had died was wrong.
    await hook('PostToolUse', 's1', { tool_name: 'Edit' });

    expect(runFor('s1').ended_at).toBeNull();
    expect(runFor('s1').end_reason).toBeNull();
  });

  it('says nothing when there was nothing to close', () => {
    expect(describeReconcile({ backfilled: 0, interrupted: 0 })).toBeNull();
  });

  it('distinguishes the two cases when it reports', () => {
    const note = describeReconcile({ backfilled: 2, interrupted: 3 });
    expect(note).toContain('Closed 5 run(s)');
    expect(note).toContain('2 had already ended');
    expect(note).toContain('3 were cut off');
  });
});
