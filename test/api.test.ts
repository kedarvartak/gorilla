import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '../src/server/app.js';
import { openDatabase, type DatabaseHandle } from '../src/server/db/client.js';
import {
  needsRenumber,
  positionForIndex,
  renumber,
  POSITION_GAP,
} from '../src/server/api/positions.js';

let dir: string;
let database: DatabaseHandle;
let app: FastifyInstance;
let boardId: string;
let columnIds: Record<string, string>;

async function json<T>(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  payload?: unknown,
): Promise<{ status: number; body: T }> {
  const response = await app.inject({
    method,
    url,
    ...(payload === undefined ? {} : { payload: payload as object }),
  });

  return {
    status: response.statusCode,
    body: response.body === '' ? (undefined as T) : (response.json() as T),
  };
}

async function makeCard(title: string, extra: Record<string, unknown> = {}): Promise<string> {
  const created = await json<{ id: string }>('POST', `/api/boards/${boardId}/cards`, {
    title,
    ...extra,
  });
  return created.body.id;
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'gorilla-api-'));
  database = openDatabase({ path: join(dir, 'api.db') });
  app = buildApp({ database, logger: false });
  await app.ready();

  const board = await json<{ id: string }>('POST', '/api/boards', { name: 'test', cwd: dir });
  boardId = board.body.id;

  const cols = await json<{ id: string; name: string }[]>('GET', `/api/boards/${boardId}/columns`);
  columnIds = Object.fromEntries(cols.body.map((column) => [column.name, column.id]));
});

afterEach(async () => {
  await app.close();
  database.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('positions', () => {
  it('spaces cards so an insertion writes one row', () => {
    const siblings = [
      { id: 'a', position: 1000 },
      { id: 'b', position: 2000 },
    ];

    expect(positionForIndex(siblings, 1)).toBe(1500);
    expect(positionForIndex(siblings, 0)).toBe(0);
    expect(positionForIndex(siblings, 2)).toBe(3000);
    expect(positionForIndex([], 0)).toBe(POSITION_GAP);
  });

  it('clamps an out-of-range index rather than producing NaN', () => {
    const siblings = [{ id: 'a', position: 1000 }];
    expect(Number.isFinite(positionForIndex(siblings, 99))).toBe(true);
    expect(Number.isFinite(positionForIndex(siblings, -5))).toBe(true);
  });

  it('detects when the gap has collapsed', () => {
    expect(
      needsRenumber([
        { id: 'a', position: 1 },
        { id: 'b', position: 2 },
      ]),
    ).toBe(false);
    expect(
      needsRenumber([
        { id: 'a', position: 1 },
        { id: 'b', position: 1 },
      ]),
    ).toBe(true);
  });

  it('renumbers while preserving order', () => {
    const renumbered = renumber([
      { id: 'b', position: 5 },
      { id: 'a', position: 1 },
    ]);
    expect(renumbered.map((r) => r.id)).toEqual(['a', 'b']);
    expect(renumbered.map((r) => r.position)).toEqual([1000, 2000]);
  });
});

describe('boards', () => {
  it('creates default columns with the board', async () => {
    const cols = await json<unknown[]>('GET', `/api/boards/${boardId}/columns`);
    expect(cols.body).toHaveLength(5);
  });

  it('refuses a second board for the same directory', async () => {
    const second = await json<{ error: string; field: string }>('POST', '/api/boards', {
      cwd: dir,
    });

    // Events route by cwd, so two boards on one directory make attribution
    // ambiguous.
    expect(second.status).toBe(409);
    expect(second.body.field).toBe('cwd');
  });

  it('requires a working directory', async () => {
    const response = await json<{ field: string }>('POST', '/api/boards', { name: 'x' });
    expect(response.status).toBe(400);
    expect(response.body.field).toBe('cwd');
  });
});

describe('cards', () => {
  it('creates a card in the first column by default', async () => {
    const created = await json<{ id: string; columnId: string; title: string }>(
      'POST',
      `/api/boards/${boardId}/cards`,
      { title: 'First card' },
    );

    expect(created.status).toBe(201);
    expect(created.body.columnId).toBe(columnIds['Intake']);
  });

  it('names the field when validation fails', async () => {
    const response = await json<{ error: string; field: string }>(
      'POST',
      `/api/boards/${boardId}/cards`,
      { title: '   ' },
    );

    expect(response.status).toBe(400);
    expect(response.body.field).toBe('title');
    expect(response.body.error).toContain('title');
  });

  it('round-trips guardrails and returns their enforcement kind', async () => {
    const id = await makeCard('Guarded', {
      guardrails: { prohibit: ['src/db/schema.ts', 'be careless'], verify: 'npm test' },
    });

    const card = await json<{
      guardrails: { prohibit: string[] };
      guardrailDetail: { text: string; enforcement: string }[];
    }>('GET', `/api/cards/${id}`);

    expect(card.body.guardrails.prohibit).toEqual(['src/db/schema.ts', 'be careless']);

    // The interface must be able to tell these apart (R10).
    const hard = card.body.guardrailDetail.filter((g) => g.enforcement === 'hard');
    const advisory = card.body.guardrailDetail.filter((g) => g.enforcement === 'advisory');
    expect(hard.some((g) => g.text.includes('schema.ts'))).toBe(true);
    expect(advisory.some((g) => g.text.includes('careless'))).toBe(true);
  });

  it('updates a card', async () => {
    const id = await makeCard('Before');
    const updated = await json<{ title: string }>('PATCH', `/api/cards/${id}`, {
      title: 'After',
      agentModel: 'sonnet',
    });

    expect(updated.body.title).toBe('After');
  });

  it('deletes a card', async () => {
    const id = await makeCard('Doomed');
    expect((await json('DELETE', `/api/cards/${id}`)).status).toBe(204);
    expect((await json('GET', `/api/cards/${id}`)).status).toBe(404);
  });

  it('reports a missing card as 404, not 500', async () => {
    expect((await json('GET', '/api/cards/nope')).status).toBe(404);
  });
});

describe('moving', () => {
  it('reorders within a column', async () => {
    const a = await makeCard('a');
    const b = await makeCard('b');
    const c = await makeCard('c');

    // Move c to the front.
    await json('POST', `/api/cards/${c}/move`, { columnId: columnIds['Intake'], index: 0 });

    const cards = await json<{ id: string }[]>('GET', `/api/boards/${boardId}/cards`);
    expect(cards.body.map((card) => card.id)).toEqual([c, a, b]);
  });

  it('moves across columns', async () => {
    const id = await makeCard('travels');
    const moved = await json<{ columnId: string }>('POST', `/api/cards/${id}/move`, {
      columnId: columnIds['Ready'],
      index: 0,
    });

    expect(moved.body.columnId).toBe(columnIds['Ready']);
  });

  it('refuses the terminal column while a dependency is unfinished', async () => {
    const first = await makeCard('first');
    const second = await makeCard('second');
    await json('POST', `/api/cards/${second}/dependencies`, { dependsOn: first });

    const response = await json<{ error: string }>('POST', `/api/cards/${second}/move`, {
      columnId: columnIds['Done'],
      index: 0,
    });

    expect(response.status).toBe(409);
    expect(response.body.error).toContain('first');
  });

  it('requires a target column', async () => {
    const id = await makeCard('x');
    const response = await json<{ field: string }>('POST', `/api/cards/${id}/move`, {});

    expect(response.status).toBe(400);
    expect(response.body.field).toBe('columnId');
  });

  it('keeps ordering consistent when two cards move concurrently', async () => {
    const a = await makeCard('a');
    const b = await makeCard('b');
    const c = await makeCard('c');

    await Promise.all([
      json('POST', `/api/cards/${a}/move`, { columnId: columnIds['Ready'], index: 0 }),
      json('POST', `/api/cards/${b}/move`, { columnId: columnIds['Ready'], index: 0 }),
    ]);

    const cards = await json<{ id: string; columnId: string; position: number }[]>(
      'GET',
      `/api/boards/${boardId}/cards`,
    );

    const ready = cards.body.filter((card) => card.columnId === columnIds['Ready']);
    expect(ready).toHaveLength(2);
    // Distinct positions: neither move may land on top of the other.
    expect(new Set(ready.map((card) => card.position)).size).toBe(2);
    expect(cards.body.find((card) => card.id === c)?.columnId).toBe(columnIds['Intake']);
  });
});

describe('dependencies', () => {
  it('refuses a cycle', async () => {
    const a = await makeCard('a');
    const b = await makeCard('b');

    await json('POST', `/api/cards/${b}/dependencies`, { dependsOn: a });
    const response = await json<{ error: string }>('POST', `/api/cards/${a}/dependencies`, {
      dependsOn: b,
    });

    expect(response.status).toBe(409);
    expect(response.body.error).toContain('cycle');
  });

  it('is idempotent', async () => {
    const a = await makeCard('a');
    const b = await makeCard('b');

    await json('POST', `/api/cards/${b}/dependencies`, { dependsOn: a });
    await json('POST', `/api/cards/${b}/dependencies`, { dependsOn: a });

    const card = await json<{ dependsOn: string[] }>('GET', `/api/cards/${b}`);
    expect(card.body.dependsOn).toEqual([a]);
  });

  it('removes a dependency', async () => {
    const a = await makeCard('a');
    const b = await makeCard('b');

    await json('POST', `/api/cards/${b}/dependencies`, { dependsOn: a });
    await json('DELETE', `/api/cards/${b}/dependencies/${a}`);

    expect((await json<{ dependsOn: string[] }>('GET', `/api/cards/${b}`)).body.dependsOn).toEqual(
      [],
    );
  });
});

describe('dispatchable', () => {
  it('lists only unblocked ready cards', async () => {
    // Both need a goal condition: a card without one is not dispatchable,
    // because dispatching it can only halt the queue with `no-goal`.
    const goal = '`npm test` exits 0, or stop after 20 turns';
    const blocker = await makeCard('blocker', { goalCondition: goal });
    const blocked = await makeCard('blocked', { goalCondition: goal });
    await json('POST', `/api/cards/${blocked}/dependencies`, { dependsOn: blocker });

    for (const id of [blocker, blocked]) {
      await json('POST', `/api/cards/${id}/move`, { columnId: columnIds['Ready'], index: 0 });
    }

    const eligible = await json<{ id: string }[]>('GET', `/api/boards/${boardId}/dispatchable`);
    expect(eligible.body.map((card) => card.id)).toEqual([blocker]);
  });
});

describe('seen', () => {
  it('records when the operator looked', async () => {
    const id = await makeCard('watched');
    expect(
      (await json<{ lastSeenAt: number | null }>('GET', `/api/cards/${id}`)).body.lastSeenAt,
    ).toBeNull();

    await json('POST', `/api/cards/${id}/seen`);

    const card = await json<{ lastSeenAt: number | null }>('GET', `/api/cards/${id}`);
    expect(card.body.lastSeenAt).toBeGreaterThan(0);
  });
});

describe('live updates', () => {
  it('publishes a frame for create, move and delete', async () => {
    // Over a real socket, because the point is that a second tab sees changes
    // without polling.
    const { startServer } = await import('../src/server/start.js');
    const server = await startServer({ port: 4487, dbPath: join(dir, 'live.db'), logger: false });

    try {
      const board = await fetch(`${server.url}/api/boards`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cwd: join(dir, 'live-project') }),
      });
      const { id: liveBoard } = (await board.json()) as { id: string };

      const columnsResponse = await fetch(`${server.url}/api/boards/${liveBoard}/columns`);
      const cols = (await columnsResponse.json()) as { id: string; name: string }[];
      const ready = cols.find((column) => column.name === 'Ready');

      const controller = new AbortController();
      const stream = await fetch(`${server.url}/stream`, { signal: controller.signal });
      const reader = stream.body?.getReader();
      if (reader === undefined) throw new Error('no stream');

      const created = await fetch(`${server.url}/api/boards/${liveBoard}/cards`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'published' }),
      });
      const { id: cardId } = (await created.json()) as { id: string };

      await fetch(`${server.url}/api/cards/${cardId}/move`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ columnId: ready?.id, index: 0 }),
      });
      await fetch(`${server.url}/api/cards/${cardId}`, { method: 'DELETE' });

      const decoder = new TextDecoder();
      let buffer = '';
      const deadline = Date.now() + 5_000;

      while (Date.now() < deadline && !buffer.includes('card-deleted')) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
      }
      controller.abort();

      expect(buffer).toContain('event: card-created');
      expect(buffer).toContain('event: card-moved');
      expect(buffer).toContain('event: card-deleted');
    } finally {
      await server.stop();
    }
  });
});

describe('first run', () => {
  it('creates a board for the directory serve was started in', async () => {
    // Otherwise the first thing an operator must do is POST JSON, which is a
    // poor answer to "how do I use this" (P9).
    const { startServer } = await import('../src/server/start.js');
    const project = join(dir, 'auto-board');
    mkdirSync(project, { recursive: true });

    const server = await startServer({
      port: 4489,
      dbPath: join(dir, 'auto.db'),
      logger: false,
      cwd: project,
    });

    try {
      expect(server.board?.created).toBe(true);
      expect(server.board?.name).toBe('auto-board');

      const boards = (await (await fetch(`${server.url}/api/boards`)).json()) as unknown[];
      expect(boards).toHaveLength(1);

      const columns = (await (
        await fetch(`${server.url}/api/boards/${server.board?.id ?? ''}/columns`)
      ).json()) as unknown[];
      expect(columns).toHaveLength(5);
    } finally {
      await server.stop();
    }
  });

  it('reuses the board on a restart rather than making another', async () => {
    const { startServer } = await import('../src/server/start.js');
    const project = join(dir, 'reused');
    mkdirSync(project, { recursive: true });
    const dbPath = join(dir, 'reused.db');

    const first = await startServer({ port: 4490, dbPath, logger: false, cwd: project });
    const firstId = first.board?.id;
    await first.stop();

    const second = await startServer({ port: 4490, dbPath, logger: false, cwd: project });
    try {
      expect(second.board?.created).toBe(false);
      expect(second.board?.id).toBe(firstId);
    } finally {
      await second.stop();
    }
  });
});

describe('per-card model preference', () => {
  it('round-trips every field that reaches the CLI', async () => {
    const id = await makeCard('Model preferences');

    const patched = await json<{
      agentModel: string | null;
      agentEffort: string | null;
      synthesisModel: string | null;
    }>('PATCH', `/api/cards/${id}`, {
      agentModel: 'opus',
      agentEffort: 'xhigh',
      synthesisModel: 'haiku',
    });

    expect(patched.status).toBe(200);
    expect(patched.body.agentModel).toBe('opus');
    // agentEffort was in the schema and passed to `--effort`, but no route
    // accepted it, so the column could never be set from anywhere.
    expect(patched.body.agentEffort).toBe('xhigh');
    expect(patched.body.synthesisModel).toBe('haiku');
  });

  it('clears back to the board default', async () => {
    const id = await makeCard('Back to default', { agentModel: 'opus' });

    const cleared = await json<{ agentModel: string | null }>('PATCH', `/api/cards/${id}`, {
      agentModel: null,
    });

    // Null is a real choice, not a missing field: it means "board default".
    expect(cleared.body.agentModel).toBeNull();
  });

  it('leaves unnamed fields alone', async () => {
    const id = await makeCard('Partial edit', { agentModel: 'sonnet' });
    await json('PATCH', `/api/cards/${id}`, { agentEffort: 'low' });

    const card = await json<{ agentModel: string | null; agentEffort: string | null }>(
      'GET',
      `/api/cards/${id}`,
    );

    expect(card.body.agentModel).toBe('sonnet');
    expect(card.body.agentEffort).toBe('low');
  });

  it('accepts the effort at creation too', async () => {
    const id = await makeCard('Created with effort', { agentEffort: 'max' });
    const card = await json<{ agentEffort: string | null }>('GET', `/api/cards/${id}`);
    expect(card.body.agentEffort).toBe('max');
  });
});

describe('priority over the API', () => {
  it('is set at creation and shown on the card', async () => {
    const created = await json<{ id: string; priority: string }>(
      'POST',
      `/api/boards/${boardId}/cards`,
      { title: 'Urgent thing', priority: 'high' },
    );

    expect(created.body.priority).toBe('high');
  });

  it('refuses an unknown priority rather than storing it', async () => {
    const refused = await json<{ error: string; field: string }>(
      'POST',
      `/api/boards/${boardId}/cards`,
      { title: 'Bad priority', priority: 'urgent' },
    );

    expect(refused.status).toBe(400);
    expect(refused.body.field).toBe('priority');
    expect(refused.body.error).toContain('high, normal, low');
  });

  it('can be changed later', async () => {
    const id = await makeCard('Promote me');
    const patched = await json<{ priority: string }>('PATCH', `/api/cards/${id}`, {
      priority: 'high',
    });
    expect(patched.body.priority).toBe('high');
  });
});

describe('the merged marker', () => {
  it('is absent on a card nobody merged', async () => {
    const id = await makeCard('Never merged');
    const card = await json<{ mergedAt: number | null; mergedInto: string | null }>(
      'GET',
      `/api/cards/${id}`,
    );

    // Null is the fact "the board did not merge this", not a missing value.
    expect(card.body.mergedAt).toBeNull();
    expect(card.body.mergedInto).toBeNull();
  });

  it('stays absent when the operator just marks a card done', async () => {
    const id = await makeCard('Finished another way');
    const done = await json<{ status: string; mergedAt: number | null }>(
      'PATCH',
      `/api/cards/${id}`,
      { status: 'done' },
    );

    // The ambiguity this exists to remove: done, but not merged by the board.
    expect(done.body.status).toBe('done');
    expect(done.body.mergedAt).toBeNull();
  });
});

describe('making a card dispatchable from the interface', () => {
  it('a title-only card becomes dispatchable once given a goal', async () => {
    const ready = columnIds['Ready'] ?? '';
    const id = await makeCard('Title only', { columnId: ready });

    const before = await json<{ id: string }[]>('GET', `/api/boards/${boardId}/dispatchable`);
    expect(before.body.map((entry) => entry.id)).not.toContain(id);

    await json('PATCH', `/api/cards/${id}`, {
      goalCondition: '`npm test` exits 0, verified by showing its output, or stop after 20 turns',
    });

    // The dead end this closes: the Add button made cards that could never run,
    // and every real one had to be created by curl.
    const after = await json<{ id: string }[]>('GET', `/api/boards/${boardId}/dispatchable`);
    expect(after.body.map((entry) => entry.id)).toContain(id);
  });

  it('accepts a whole guardrail set and keeps the enforcement split', async () => {
    const id = await makeCard('Guarded');

    const patched = await json<{
      guardrails: { scope: string[]; prohibit: string[]; verify: string | null };
      guardrailDetail: { text: string; enforcement: string }[];
    }>('PATCH', `/api/cards/${id}`, {
      guardrails: {
        scope: ['src/server/'],
        prohibit: ['src/db/schema.ts', 'do not over-engineer'],
        verify: 'npm test',
      },
    });

    expect(patched.body.guardrails.verify).toBe('npm test');
    expect(patched.body.guardrails.scope).toEqual(['src/server/']);

    // The point of editing them at all: a path prohibition is enforced and a
    // sentence of advice is not, and the interface must be able to say which.
    const byText = new Map(
      patched.body.guardrailDetail.map((rail) => [rail.text, rail.enforcement]),
    );
    expect(byText.get('Do not src/db/schema.ts')).toBe('hard');
    expect(byText.get('Do not do not over-engineer')).toBe('advisory');
  });

  it('replaces the set rather than merging into it', async () => {
    const id = await makeCard('Replaced', {
      guardrails: { scope: ['old/'], verify: 'old command' },
    });

    const patched = await json<{ guardrails: { scope: string[]; verify: string | null } }>(
      'PATCH',
      `/api/cards/${id}`,
      { guardrails: { scope: ['new/'], verify: 'new command' } },
    );

    // The interface sends the whole set for this reason: a partial write would
    // silently drop rules the operator still believed were in force.
    expect(patched.body.guardrails.scope).toEqual(['new/']);
    expect(patched.body.guardrails.verify).toBe('new command');
  });
});

describe('staleness on the board', () => {
  it('marks a card whose files all exist and which never ran', async () => {
    // The shape of a card describing something already built: it names files,
    // they are all there, and nothing was ever dispatched against it.
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'already.ts'), 'export const built = true;\n');

    await makeCard('Already built', { body: 'Change `src/already.ts`.' });

    const cards = await json<{ title: string; looksFinished: boolean }[]>(
      'GET',
      `/api/boards/${boardId}/cards`,
    );

    const card = cards.body.find((entry) => entry.title === 'Already built');
    expect(card?.looksFinished).toBe(true);
  });

  it('does not mark a card that names nothing on disk', async () => {
    await makeCard('Genuinely new', { body: 'Create `src/does-not-exist-yet.ts`.' });

    const cards = await json<{ title: string; looksFinished: boolean }[]>(
      'GET',
      `/api/boards/${boardId}/cards`,
    );

    expect(cards.body.find((entry) => entry.title === 'Genuinely new')?.looksFinished).toBe(false);
  });

  it('never marks a finished card', async () => {
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'finished.ts'), 'x\n');

    const id = await makeCard('Done already', { body: 'Change `src/finished.ts`.' });
    await json('PATCH', `/api/cards/${id}`, { status: 'done' });

    // A "may be done" flag on a done card is noise at best and a contradiction
    // at worst.
    const cards = await json<{ title: string; looksFinished: boolean }[]>(
      'GET',
      `/api/boards/${boardId}/cards`,
    );

    expect(cards.body.find((entry) => entry.title === 'Done already')?.looksFinished).toBe(false);
  });
});

describe('updating a card with a field it does not have', () => {
  it('refuses instead of ignoring it', async () => {
    const card = await json<{ id: string }>('POST', `/api/boards/${boardId}/cards`, {
      title: 'a card',
    });

    // An update that accepts a field it does not know reports success for a
    // change it did not make, and the operator finds out when the card behaves
    // as though they never edited it (T4).
    const refused = await json<{ error: string; field: string }>(
      'PATCH',
      `/api/cards/${card.body.id}`,
      { titel: 'a typo' },
    );

    expect(refused.status).toBe(400);
    expect(refused.body.field).toBe('titel');
  });

  it('says which fields it does have', async () => {
    const card = await json<{ id: string }>('POST', `/api/boards/${boardId}/cards`, {
      title: 'a card',
    });

    const refused = await json<{ error: string }>('PATCH', `/api/cards/${card.body.id}`, {
      nonsense: 1,
    });

    // A refusal that does not say what would have worked leaves the operator
    // guessing at an API they cannot see.
    expect(refused.body.error).toContain('goalCondition');
  });

  it('still accepts every field it does have', async () => {
    const card = await json<{ id: string }>('POST', `/api/boards/${boardId}/cards`, {
      title: 'a card',
    });

    const updated = await json('PATCH', `/api/cards/${card.body.id}`, {
      title: 'renamed',
      body: 'described',
      goalCondition: 'measurable',
      priority: 'high',
      tokenCeiling: 1_000,
    });

    expect(updated.status).toBe(200);
  });
});

describe('the shape of a refusal', () => {
  it('says what kind it was, not only what happened', async () => {
    const refused = await json<{ code: string; error: string }>(
      'POST',
      `/api/boards/${boardId}/cards`,
      { title: '' },
    );

    // Prose is written for a person, gets reworded, and a client that branches
    // on it breaks silently when somebody improves a sentence (T8).
    expect(refused.status).toBe(400);
    expect(refused.body.code).toBe('invalid-field');
  });

  it('uses the same shape for a thrown refusal as for a decided one', async () => {
    // One path starts in a handler, the other as a thrown CardError. Nothing
    // downstream should have to know which.
    const missing = await json<{ code: string }>('GET', '/api/cards/no-such-card/detail');

    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe('not-found');
  });

  it('still names the field, so the message can go where the operator is looking', async () => {
    const card = await json<{ id: string }>('POST', `/api/boards/${boardId}/cards`, {
      title: 'a card',
    });

    const refused = await json<{ code: string; field: string }>(
      'PATCH',
      `/api/cards/${card.body.id}`,
      { tokenCeiling: 0 },
    );

    expect(refused.body.code).toBe('invalid-field');
    expect(refused.body.field).toBe('tokenCeiling');
  });
});
