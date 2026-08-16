import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { and, count, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDatabase, resolveDatabasePath, type DatabaseHandle } from '../src/server/db/client.js';
import { boards, events, runs } from '../src/server/db/schema.js';

let dir: string;
let handle: DatabaseHandle;

const BOARD_ID = 'board-1';
const RUN_ID = 'run-1';
const SESSION_ID = 'ba5eba11-0000-4000-8000-000000000001';

function seed(h: DatabaseHandle): void {
  h.db
    .insert(boards)
    .values({
      id: BOARD_ID,
      name: 'gorilla',
      cwd: '/home/example/project',
      createdAt: Date.now(),
    })
    .run();

  h.db
    .insert(runs)
    .values({
      id: RUN_ID,
      boardId: BOARD_ID,
      sessionId: SESSION_ID,
      mode: 'attached',
      startedAt: Date.now(),
      cwd: '/home/example/project',
    })
    .run();
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gorilla-test-'));
  handle = openDatabase({ path: join(dir, 'test.db') });
});

afterEach(() => {
  handle.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('migrations', () => {
  it('creates every table', () => {
    const names = handle.sqlite
      .prepare<[], { name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
      )
      .all()
      .map((row) => row.name);

    expect(names).toContain('boards');
    expect(names).toContain('runs');
    expect(names).toContain('events');
  });

  it('creates the indexes the ingest path queries on', () => {
    const names = handle.sqlite
      .prepare<[], { name: string }>("SELECT name FROM sqlite_master WHERE type = 'index'")
      .all()
      .map((row) => row.name);

    expect(names).toEqual(
      expect.arrayContaining([
        'boards_cwd_unique',
        'runs_session_unique',
        'events_run_seq_unique',
        'events_session_seq',
        'events_name_received',
        'events_tool_name',
      ]),
    );
  });

  it('is idempotent when reopened', () => {
    handle.close();
    const reopened = openDatabase({ path: join(dir, 'test.db') });
    expect(() => reopened.sqlite.prepare('SELECT 1 FROM events').all()).not.toThrow();
    reopened.close();
  });

  it('enables WAL and foreign keys', () => {
    expect(String(handle.sqlite.pragma('journal_mode', { simple: true }))).toBe('wal');
    expect(handle.sqlite.pragma('foreign_keys', { simple: true })).toBe(1);
  });
});

describe('constraints', () => {
  beforeEach(() => {
    seed(handle);
  });

  it('rejects a second run for the same session', () => {
    expect(() =>
      handle.db
        .insert(runs)
        .values({
          id: 'run-2',
          boardId: BOARD_ID,
          sessionId: SESSION_ID,
          startedAt: Date.now(),
          cwd: '/home/example/project',
        })
        .run(),
    ).toThrow(/UNIQUE/i);
  });

  it('rejects duplicate sequence numbers within a run', () => {
    const row = {
      runId: RUN_ID,
      sessionId: SESSION_ID,
      eventName: 'Stop',
      receivedAt: Date.now(),
      payload: '{}',
    };
    handle.db
      .insert(events)
      .values({ ...row, seq: 1 })
      .run();
    expect(() =>
      handle.db
        .insert(events)
        .values({ ...row, seq: 1 })
        .run(),
    ).toThrow(/UNIQUE/i);
  });

  it('rejects an event for an unknown run', () => {
    expect(() =>
      handle.db
        .insert(events)
        .values({
          runId: 'does-not-exist',
          sessionId: SESSION_ID,
          seq: 1,
          eventName: 'Stop',
          receivedAt: Date.now(),
          payload: '{}',
        })
        .run(),
    ).toThrow(/FOREIGN KEY/i);
  });
});

describe('generated columns', () => {
  beforeEach(() => {
    seed(handle);
  });

  it('extracts correlation fields from the payload', () => {
    handle.db
      .insert(events)
      .values({
        runId: RUN_ID,
        sessionId: SESSION_ID,
        seq: 1,
        eventName: 'PostToolUse',
        receivedAt: Date.now(),
        payload: JSON.stringify({
          tool_name: 'Edit',
          tool_use_id: 'toolu_123',
          prompt_id: 'prompt_456',
          agent_id: 'agent_789',
        }),
      })
      .run();

    const row = handle.db.select().from(events).where(eq(events.seq, 1)).get();
    expect(row?.toolName).toBe('Edit');
    expect(row?.toolUseId).toBe('toolu_123');
    expect(row?.promptId).toBe('prompt_456');
    expect(row?.agentId).toBe('agent_789');
  });

  it('leaves correlation fields null when the payload omits them', () => {
    handle.db
      .insert(events)
      .values({
        runId: RUN_ID,
        sessionId: SESSION_ID,
        seq: 2,
        eventName: 'SessionStart',
        receivedAt: Date.now(),
        payload: JSON.stringify({ session_id: SESSION_ID }),
      })
      .run();

    const row = handle.db.select().from(events).where(eq(events.seq, 2)).get();
    expect(row?.toolName).toBeNull();
    expect(row?.agentId).toBeNull();
  });
});

describe('throughput', () => {
  const TOTAL = 10_000;

  it('writes and queries ten thousand events', () => {
    seed(handle);

    const insert = handle.sqlite.prepare(
      'INSERT INTO events (run_id, session_id, seq, event_name, received_at, payload) VALUES (?, ?, ?, ?, ?, ?)',
    );
    const names = ['PreToolUse', 'PostToolUse', 'Stop', 'Notification'] as const;

    const writeAll = handle.sqlite.transaction((n: number) => {
      for (let i = 0; i < n; i += 1) {
        insert.run(
          RUN_ID,
          SESSION_ID,
          i + 1,
          names[i % names.length],
          Date.now(),
          JSON.stringify({ tool_name: i % 2 === 0 ? 'Edit' : 'Bash', i }),
        );
      }
    });

    const startWrite = performance.now();
    writeAll(TOTAL);
    const writeMs = performance.now() - startWrite;

    const startRead = performance.now();
    const bySession = handle.db
      .select({ n: count() })
      .from(events)
      .where(eq(events.sessionId, SESSION_ID))
      .get();
    const byName = handle.db
      .select({ n: count() })
      .from(events)
      .where(and(eq(events.sessionId, SESSION_ID), eq(events.eventName, 'Stop')))
      .get();
    const byTool = handle.db
      .select({ n: count() })
      .from(events)
      .where(eq(events.toolName, 'Edit'))
      .get();
    const readMs = performance.now() - startRead;

    expect(bySession?.n).toBe(TOTAL);
    expect(byName?.n).toBe(TOTAL / names.length);
    expect(byTool?.n).toBe(TOTAL / 2);

    const perSecond = Math.round(TOTAL / (writeMs / 1000));
    // Reported rather than asserted tightly: the point is visibility in the
    // transcript, and CI runners vary too much for a meaningful upper bound.
    console.error(
      `[throughput] wrote ${TOTAL} events in ${writeMs.toFixed(0)}ms (${perSecond}/s); ` +
        `three indexed aggregates in ${readMs.toFixed(1)}ms`,
    );

    expect(writeMs).toBeLessThan(10_000);
  });

  it('keeps a seq lookup on a large table indexed', () => {
    seed(handle);
    const insert = handle.sqlite.prepare(
      'INSERT INTO events (run_id, session_id, seq, event_name, received_at, payload) VALUES (?, ?, ?, ?, ?, ?)',
    );
    handle.sqlite.transaction(() => {
      for (let i = 0; i < 1_000; i += 1) {
        insert.run(RUN_ID, SESSION_ID, i + 1, 'Stop', Date.now(), '{}');
      }
    })();

    const plan = handle.sqlite
      .prepare<[], { detail: string }>(
        'EXPLAIN QUERY PLAN SELECT * FROM events WHERE run_id = ? AND seq = ?',
      )
      .all(RUN_ID, 500) as unknown as { detail: string }[];

    expect(plan.map((p) => p.detail).join(' ')).toMatch(/USING INDEX events_run_seq_unique/);
  });
});

describe('resolveDatabasePath', () => {
  const original = process.env['GORILLA_DB_PATH'];
  afterEach(() => {
    if (original === undefined) delete process.env['GORILLA_DB_PATH'];
    else process.env['GORILLA_DB_PATH'] = original;
  });

  it('prefers the explicit path', () => {
    process.env['GORILLA_DB_PATH'] = '/from/env.db';
    expect(resolveDatabasePath('/explicit.db')).toBe('/explicit.db');
  });

  it('falls back to the environment variable', () => {
    process.env['GORILLA_DB_PATH'] = '/from/env.db';
    expect(resolveDatabasePath()).toBe('/from/env.db');
  });

  it('defaults under the home directory', () => {
    delete process.env['GORILLA_DB_PATH'];
    expect(resolveDatabasePath()).toMatch(/\.gorilla[/\\]gorilla\.db$/);
  });
});

describe('in-memory databases', () => {
  it('migrates without touching the filesystem', () => {
    const memory = openDatabase({ path: ':memory:' });
    expect(() => memory.sqlite.prepare('SELECT 1 FROM events').all()).not.toThrow();
    memory.close();
  });
});

describe('migration bookkeeping', () => {
  it('records the applied migration so a reopen does not reapply it', () => {
    const applied = handle.sqlite
      .prepare<[], { count: number }>('SELECT COUNT(*) AS count FROM __drizzle_migrations')
      .get();
    expect(applied?.count).toBe(1);
  });
});
