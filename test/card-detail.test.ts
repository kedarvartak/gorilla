import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '../src/server/app.js';
import { openDatabase, type DatabaseHandle } from '../src/server/db/client.js';

let dir: string;
let repo: string;
let database: DatabaseHandle;
let app: FastifyInstance;
let boardId: string;

interface Detail {
  card: { title: string; goalCondition: string | null };
  guardrailDetail: { text: string; enforcement: string; because: string }[];
  blockers: { title: string }[];
  runs: {
    runId: string;
    events: number;
    ledger: { entries: { kind: string; statement: string; sourceEventIds: number[] }[] };
  }[];
  realityNotes: string[];
}

async function detailFor(cardId: string): Promise<Detail> {
  const response = await app.inject({ method: 'GET', url: `/api/cards/${cardId}/detail` });
  return response.json() as Detail;
}

async function makeCard(title: string, extra: Record<string, unknown> = {}): Promise<string> {
  const created = await app.inject({
    method: 'POST',
    url: `/api/boards/${boardId}/cards`,
    payload: { title, ...extra },
  });
  return (created.json() as { id: string }).id;
}

async function hook(event: string, payload: Record<string, unknown>): Promise<void> {
  await app.inject({
    method: 'POST',
    url: `/hooks/${event}`,
    payload: { session_id: 'sess-detail', cwd: repo, hook_event_name: event, ...payload },
  });
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'gorilla-detail-'));
  repo = join(dir, 'repo');
  mkdirSync(repo, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['config', 'user.email', 't@example.com'], { cwd: repo });
  execFileSync('git', ['config', 'user.name', 'T'], { cwd: repo });
  writeFileSync(join(repo, 'tracked.txt'), 'original\n');
  execFileSync('git', ['add', '.'], { cwd: repo });
  execFileSync('git', ['commit', '-qm', 'initial'], { cwd: repo });

  database = openDatabase({ path: join(dir, 'detail.db') });
  app = buildApp({ database, logger: false });
  await app.ready();

  const board = await app.inject({
    method: 'POST',
    url: '/api/boards',
    payload: { name: 'detail', cwd: repo },
  });
  boardId = (board.json() as { id: string }).id;
});

afterEach(async () => {
  await app.close();
  database.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('card detail', () => {
  it('returns everything the view needs in one request', async () => {
    const cardId = await makeCard('Detailed', {
      goalCondition: '`npm test` exits 0',
      guardrails: { prohibit: ['src/db/schema.ts', 'be careless'], verify: 'npm test' },
    });

    const detail = await detailFor(cardId);

    // Three round trips to render one card is three chances for the panes to
    // disagree with each other.
    expect(detail.card.title).toBe('Detailed');
    expect(detail.guardrailDetail.length).toBeGreaterThan(0);
    expect(detail.runs).toEqual([]);
    expect(detail.realityNotes.length).toBeGreaterThan(0);
  });

  it('labels each guardrail with its enforcement and a reason', async () => {
    const cardId = await makeCard('Guarded', {
      guardrails: { prohibit: ['src/db/schema.ts', 'be careless'] },
    });

    const detail = await detailFor(cardId);

    const hard = detail.guardrailDetail.find((rail) => rail.text.includes('schema.ts'));
    const advisory = detail.guardrailDetail.find((rail) => rail.text.includes('careless'));

    // R10: the view must be unable to present these identically.
    expect(hard?.enforcement).toBe('hard');
    expect(advisory?.enforcement).toBe('advisory');
    expect(hard?.because.length).toBeGreaterThan(10);
  });

  it('flags a card that cannot be dispatched', async () => {
    const cardId = await makeCard('No goal');
    expect((await detailFor(cardId)).card.goalCondition).toBeNull();
  });

  it('reports blockers', async () => {
    const first = await makeCard('first', { goalCondition: 'x' });
    const second = await makeCard('second', { goalCondition: 'x' });
    await app.inject({
      method: 'POST',
      url: `/api/cards/${second}/dependencies`,
      payload: { dependsOn: first },
    });

    expect((await detailFor(second)).blockers[0]?.title).toBe('first');
  });

  it('includes the mechanical ledger for each run', async () => {
    const cardId = await makeCard('Worked on', { goalCondition: 'x' });

    await hook('SessionStart', { source: 'startup' });
    await app.inject({
      method: 'POST',
      url: '/api/claim',
      payload: { sessionId: 'sess-detail', cardId },
    });
    await hook('PostToolUse', {
      tool_name: 'Edit',
      tool_input: { file_path: join(repo, 'tracked.txt') },
    });
    await hook('PostToolUseFailure', { tool_name: 'Bash', tool_error: 'boom' });

    const detail = await detailFor(cardId);

    expect(detail.runs).toHaveLength(1);
    const kinds = detail.runs[0]?.ledger.entries.map((entry) => entry.kind) ?? [];
    expect(kinds).toContain('change');
    expect(kinds).toContain('risk');
  });

  it('keeps every entry traceable to its events', async () => {
    const cardId = await makeCard('Traceable', { goalCondition: 'x' });

    await hook('SessionStart', { source: 'startup' });
    await app.inject({
      method: 'POST',
      url: '/api/claim',
      payload: { sessionId: 'sess-detail', cardId },
    });
    await hook('PostToolUse', { tool_name: 'Edit', tool_input: { file_path: '/a/b.ts' } });

    for (const entry of (await detailFor(cardId)).runs[0]?.ledger.entries ?? []) {
      expect(entry.sourceEventIds.length).toBeGreaterThan(0);
    }
  });

  it('compares the event stream against git', async () => {
    const cardId = await makeCard('Reality', { goalCondition: 'x' });

    await hook('SessionStart', { source: 'startup' });
    await app.inject({
      method: 'POST',
      url: '/api/claim',
      payload: { sessionId: 'sess-detail', cardId },
    });

    // Changed on disk, never mentioned by any tool event: where drift hides.
    writeFileSync(join(repo, 'surprise.txt'), 'nobody mentioned me\n');

    const notes = (await detailFor(cardId)).realityNotes.join(' ');
    expect(notes).toContain('surprise.txt');
  });

  it('reports a missing card as 404', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/cards/nope/detail' });
    expect(response.statusCode).toBe(404);
  });
});
