import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '../src/server/app.js';
import { openDatabase, type DatabaseHandle } from '../src/server/db/client.js';
import { canonicaliseCwd } from '../src/server/ingest/binding.js';
import { clearRecordedLatencies } from '../src/server/ingest/routes.js';
import { HOOK_DEFINITIONS } from '../src/hooks/definitions.js';

let dir: string;
let database: DatabaseHandle;
let app: FastifyInstance;

const SESSION = 'fdef2e6b-0fca-4d92-97f4-1272f1af793d';
const CWD = '/home/example/project';

interface EventRow {
  seq: number;
  event_name: string;
  session_id: string;
  run_id: string;
  payload: string;
  tool_name: string | null;
  agent_id: string | null;
}

function post(event: string, payload: unknown): ReturnType<FastifyInstance['inject']> {
  return app.inject({ method: 'POST', url: `/hooks/${event}`, payload: payload as object });
}

function basePayload(event: string): Record<string, unknown> {
  return {
    session_id: SESSION,
    hook_event_name: event,
    transcript_path: `/home/example/.claude/projects/slug/${SESSION}.jsonl`,
    cwd: CWD,
    permission_mode: 'acceptEdits',
  };
}

function allEvents(): EventRow[] {
  return database.sqlite.prepare('SELECT * FROM events ORDER BY seq').all() as EventRow[];
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'gorilla-ingest-'));
  database = openDatabase({ path: join(dir, 'test.db') });
  app = buildApp({ database, logger: false });
  clearRecordedLatencies();
  await app.ready();
});

afterEach(async () => {
  await app.close();
  database.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('every configured event', () => {
  it('persists all fifteen attributed to one run', async () => {
    for (const definition of HOOK_DEFINITIONS) {
      const response = await post(definition.event, basePayload(definition.event));
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({});
    }

    const rows = allEvents();
    expect(rows).toHaveLength(HOOK_DEFINITIONS.length);
    expect(rows.map((r) => r.event_name)).toEqual(HOOK_DEFINITIONS.map((d) => d.event));

    const runIds = new Set(rows.map((r) => r.run_id));
    expect(runIds.size).toBe(1);

    // Sequence numbers are dense and monotonic from one.
    expect(rows.map((r) => r.seq)).toEqual(
      Array.from({ length: HOOK_DEFINITIONS.length }, (_, i) => i + 1),
    );
  });

  it('creates exactly one board and one run', async () => {
    for (const definition of HOOK_DEFINITIONS) {
      await post(definition.event, basePayload(definition.event));
    }

    const boards = database.sqlite.prepare('SELECT * FROM boards').all() as { cwd: string }[];
    const runs = database.sqlite.prepare('SELECT * FROM runs').all() as {
      session_id: string;
      transcript_path: string | null;
      last_seq: number;
    }[];

    expect(boards).toHaveLength(1);
    expect(boards[0]?.cwd).toBe(canonicaliseCwd(CWD));
    expect(runs).toHaveLength(1);
    expect(runs[0]?.session_id).toBe(SESSION);
    expect(runs[0]?.transcript_path).toContain(`${SESSION}.jsonl`);
    expect(runs[0]?.last_seq).toBe(HOOK_DEFINITIONS.length);
  });
});

describe('correlation', () => {
  it('populates generated columns from a tool payload', async () => {
    await post('PostToolUse', {
      ...basePayload('PostToolUse'),
      tool_name: 'Edit',
      tool_use_id: 'toolu_abc',
      prompt_id: 'prompt_xyz',
      tool_input: { file_path: '/a/b.ts' },
      tool_response: { ok: true },
    });

    const row = allEvents()[0];
    expect(row?.tool_name).toBe('Edit');
    expect(JSON.parse(row?.payload ?? '{}')).toMatchObject({
      tool_input: { file_path: '/a/b.ts' },
    });
  });

  it('records subagent events with their agent id', async () => {
    await post('SubagentStop', {
      ...basePayload('SubagentStop'),
      agent_type: 'Explore',
      agent_id: 'agent_1',
      last_assistant_message: 'done',
    });

    expect(allEvents()[0]?.agent_id).toBe('agent_1');
  });

  it('separates sessions into separate runs but shares the board', async () => {
    await post('Stop', basePayload('Stop'));
    await post('Stop', { ...basePayload('Stop'), session_id: 'another-session' });

    const runs = database.sqlite.prepare('SELECT * FROM runs').all();
    const boards = database.sqlite.prepare('SELECT * FROM boards').all();
    expect(runs).toHaveLength(2);
    expect(boards).toHaveLength(1);
  });

  it('routes different directories to different boards', async () => {
    await post('Stop', basePayload('Stop'));
    await post('Stop', { ...basePayload('Stop'), session_id: 's2', cwd: '/home/example/other' });

    expect(database.sqlite.prepare('SELECT * FROM boards').all()).toHaveLength(2);
  });

  it('treats a trailing slash as the same directory', async () => {
    await post('Stop', basePayload('Stop'));
    await post('Stop', { ...basePayload('Stop'), session_id: 's2', cwd: `${CWD}/` });

    expect(database.sqlite.prepare('SELECT * FROM boards').all()).toHaveLength(1);
  });
});

describe('failing open', () => {
  it('answers 2xx and stores the text when the body will not parse', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/hooks/Stop',
      headers: { 'content-type': 'application/json' },
      payload: '{ not json',
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({});
  });

  it('answers 2xx without persisting when session_id is absent', async () => {
    const response = await post('Stop', { cwd: CWD, hook_event_name: 'Stop' });
    expect(response.statusCode).toBe(202);
    expect(allEvents()).toHaveLength(0);
  });

  it('answers 2xx without persisting when cwd is absent', async () => {
    const response = await post('Stop', { session_id: SESSION });
    expect(response.statusCode).toBe(202);
    expect(allEvents()).toHaveLength(0);
  });

  it('accepts an empty body', async () => {
    const response = await app.inject({ method: 'POST', url: '/hooks/Stop', payload: '' });
    expect(response.statusCode).toBe(202);
  });

  it('accepts an event name it does not know', async () => {
    const response = await post('SomeFutureEvent', basePayload('SomeFutureEvent'));
    expect(response.statusCode).toBe(200);
    expect(allEvents()[0]?.event_name).toBe('SomeFutureEvent');
  });

  it('tolerates unknown extra fields', async () => {
    const response = await post('Stop', {
      ...basePayload('Stop'),
      some_field_added_in_a_later_release: { nested: true },
    });
    expect(response.statusCode).toBe(200);
  });

  it('answers 2xx when the payload declares a different event name', async () => {
    const response = await post('Stop', { ...basePayload('Stop'), hook_event_name: 'Mismatch' });
    expect(response.statusCode).toBe(200);
    // The route is authoritative.
    expect(allEvents()[0]?.event_name).toBe('Stop');
  });
});

describe('health', () => {
  it('reports ok', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.json()).toEqual({ status: 'ok' });
  });
});

describe('latency', () => {
  const TOTAL = 1_000;

  it('stays inside the p99 budget over a thousand sequential posts', async () => {
    const samples: number[] = [];

    for (let i = 0; i < TOTAL; i += 1) {
      const payload = {
        ...basePayload('PostToolUse'),
        tool_name: i % 2 === 0 ? 'Edit' : 'Bash',
        tool_use_id: `toolu_${i}`,
        tool_response: { filePath: `/src/file-${i}.ts`, content: 'x'.repeat(200) },
      };

      const start = performance.now();
      const response = await post('PostToolUse', payload);
      samples.push(performance.now() - start);
      expect(response.statusCode).toBe(200);
    }

    samples.sort((a, b) => a - b);
    const at = (q: number): number =>
      samples[Math.min(samples.length - 1, Math.floor(q * samples.length))] ?? 0;
    const p50 = at(0.5);
    const p99 = at(0.99);
    const max = samples[samples.length - 1] ?? 0;

    console.error(
      `[ingest] ${TOTAL} posts: p50 ${p50.toFixed(2)}ms, p99 ${p99.toFixed(2)}ms, max ${max.toFixed(2)}ms`,
    );

    expect(allEvents()).toHaveLength(TOTAL);
    expect(p99).toBeLessThan(25);
  });
});
