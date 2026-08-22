import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '../src/server/app.js';
import { openDatabase, type DatabaseHandle } from '../src/server/db/client.js';
import { runs } from '../src/server/db/schema.js';

let dir: string;
let database: DatabaseHandle;
let app: FastifyInstance;
let runId: string;

interface TimelineEntry {
  seq: number;
  event: string;
  toolName: string | null;
  agentId: string | null;
  agentType: string | null;
  triggerReason: string | null;
  isCompaction: boolean;
  isTurnBoundary: boolean;
}

interface Timeline {
  total: number;
  entries: TimelineEntry[];
  nextAfter: number;
  hasMore: boolean;
}

async function emit(event: string, payload: Record<string, unknown> = {}): Promise<void> {
  await app.inject({
    method: 'POST',
    url: `/hooks/${event}`,
    payload: { session_id: 'sess-timeline', cwd: dir, hook_event_name: event, ...payload },
  });
}

async function timeline(query = ''): Promise<Timeline> {
  const response = await app.inject({
    method: 'GET',
    url: `/api/runs/${runId}/timeline${query}`,
  });
  return response.json() as Timeline;
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'gorilla-timeline-'));
  database = openDatabase({ path: join(dir, 'timeline.db') });
  app = buildApp({ database, logger: false });
  await app.ready();

  await app.inject({ method: 'POST', url: '/api/boards', payload: { name: 't', cwd: dir } });

  // A run with a subagent and a compaction: the two things the screen exists
  // to make legible.
  await emit('SessionStart', { source: 'startup' });
  await emit('UserPromptSubmit', { user_input: 'do the thing' });
  await emit('PreToolUse', { tool_name: 'Edit' });
  await emit('PostToolUse', { tool_name: 'Edit' });
  await emit('SubagentStart', { agent_id: 'agent-1', agent_type: 'Explore' });
  await emit('PreToolUse', { tool_name: 'Bash', agent_id: 'agent-1' });
  await emit('SubagentStop', { agent_id: 'agent-1', agent_type: 'Explore' });
  await emit('PreCompact', { trigger_reason: 'auto' });
  await emit('PostCompact', {});
  await emit('Stop', {});

  runId = database.db.select().from(runs).all()[0]?.id ?? '';
});

afterEach(async () => {
  await app.close();
  database.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('timeline', () => {
  it('returns the run in sequence order', async () => {
    const result = await timeline();

    expect(result.total).toBe(10);
    expect(result.entries.map((entry) => entry.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(result.entries[0]?.event).toBe('SessionStart');
  });

  it('marks compaction, which is what the screen is anchored on', async () => {
    const result = await timeline();
    const compactions = result.entries.filter((entry) => entry.isCompaction);

    expect(compactions.map((entry) => entry.event)).toEqual(['PreCompact', 'PostCompact']);
    expect(compactions[0]?.triggerReason).toBe('auto');
  });

  it('carries the agent id so subagent work can be nested', async () => {
    const result = await timeline();
    const subagent = result.entries.filter((entry) => entry.agentId === 'agent-1');

    // Work in a context window the operator never sees, so it must not be
    // flattened into the main sequence.
    expect(subagent.length).toBeGreaterThanOrEqual(2);
    expect(subagent.some((entry) => entry.agentType === 'Explore')).toBe(true);
  });

  it('marks turn boundaries', async () => {
    const result = await timeline();
    const boundaries = result.entries.filter((entry) => entry.isTurnBoundary);
    expect(boundaries.map((entry) => entry.event)).toEqual(['UserPromptSubmit', 'Stop']);
  });

  it('filters by event type', async () => {
    const result = await timeline('?event=PreToolUse');

    expect(result.entries).toHaveLength(2);
    expect(result.entries.every((entry) => entry.event === 'PreToolUse')).toBe(true);
    // The total stays the run total, so the interface can say "2 of 10".
    expect(result.total).toBe(10);
  });

  it('filters by tool', async () => {
    const result = await timeline('?tool=Bash');
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.toolName).toBe('Bash');
  });

  it('pages rather than loading a long run at once', async () => {
    const first = await timeline('?limit=4');

    expect(first.entries).toHaveLength(4);
    expect(first.hasMore).toBe(true);

    const second = await timeline(`?limit=4&after=${first.nextAfter}`);
    expect(second.entries[0]?.seq).toBe(5);
  });

  it('reports the end of the run', async () => {
    const last = await timeline('?after=9');
    expect(last.hasMore).toBe(false);
    expect(last.entries).toHaveLength(1);
  });

  it('caps an absurd limit rather than obeying it', async () => {
    const result = await timeline('?limit=99999');
    expect(result.entries.length).toBeLessThanOrEqual(1000);
  });

  it('returns an empty timeline for an unknown run', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/runs/nope/timeline' });
    expect((response.json() as Timeline).entries).toEqual([]);
  });
});

describe('facets', () => {
  it('lists the event types and tools present, with counts', async () => {
    const response = await app.inject({ method: 'GET', url: `/api/runs/${runId}/facets` });
    const body = response.json() as {
      events: { name: string; n: number }[];
      tools: { name: string; n: number }[];
    };

    expect(body.events.find((event) => event.name === 'PreToolUse')?.n).toBe(2);
    expect(body.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(['Edit', 'Bash']));
  });
});

describe('a payload that is valid JSON but not an object', () => {
  it('does not put the timeline into reading properties off a string', async () => {
    await emit('SessionStart');

    // The events table's generated columns reject unparseable JSON, not JSON
    // that parses to something other than an object. A bare string gets in,
    // and reading `payload['agent_type']` off one used to be a cast away.
    database.sqlite
      .prepare(
        'INSERT INTO events (run_id, session_id, seq, event_name, received_at, payload) VALUES (?,?,?,?,?,?)',
      )
      .run(runId, 'sess-timeline', 9_999, 'Stop', Date.now(), '"just a string"');

    const response = await app.inject({ method: 'GET', url: `/api/runs/${runId}/timeline` });

    expect(response.statusCode).toBe(200);
    const entries = response.json<Timeline>().entries;
    expect(entries.at(-1)?.agentType).toBeNull();
  });
});
