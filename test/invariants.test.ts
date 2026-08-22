import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '../src/server/app.js';
import { openDatabase, type DatabaseHandle } from '../src/server/db/client.js';
import { renderCardContext } from '../src/server/launcher/args.js';
import { EMPTY_GUARDRAILS } from '../src/server/cards/guardrails.js';

/**
 * Rules true of the project rather than of one card (doc 12, output 2).
 *
 * The point is that a standing rule is stated once. A rule repeated on every
 * card drifts, and a rule stated five ways is one nobody can rely on.
 */

let dir: string;
let database: DatabaseHandle;
let app: FastifyInstance;
let boardId: string;

async function json<T>(
  method: 'GET' | 'POST' | 'DELETE',
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

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'gorilla-invariants-'));
  database = openDatabase({ path: join(dir, 'inv.db') });
  app = buildApp({ database, logger: false });
  await app.ready();

  const board = await json<{ id: string }>('POST', '/api/boards', { name: 't', cwd: dir });
  boardId = board.body.id;
});

afterEach(async () => {
  await app.close();
  database.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('keeping a project rule', () => {
  it('stores and lists it', async () => {
    await json('POST', `/api/boards/${boardId}/invariants`, {
      statement: 'Every migration must be additive.',
    });

    const listed = await json<{ statement: string }[]>('GET', `/api/boards/${boardId}/invariants`);
    expect(listed.body.map((rule) => rule.statement)).toEqual([
      'Every migration must be additive.',
    ]);
  });

  it('refuses an empty one', async () => {
    const refused = await json<{ field: string }>('POST', `/api/boards/${boardId}/invariants`, {
      statement: '   ',
    });

    expect(refused.status).toBe(400);
    expect(refused.body.field).toBe('statement');
  });

  it('refuses a duplicate', async () => {
    const rule = { statement: 'The hook path must never block.' };
    await json('POST', `/api/boards/${boardId}/invariants`, rule);

    // Two copies of one rule is the drift this exists to prevent, arriving by a
    // shorter route.
    const second = await json('POST', `/api/boards/${boardId}/invariants`, rule);
    expect(second.status).toBe(409);
  });

  it('remembers which card discovered it', async () => {
    const created = await json<{ sourceCardId: string | null }>(
      'POST',
      `/api/boards/${boardId}/invariants`,
      { statement: 'Events are append-only.', sourceCardId: 'card-7' },
    );

    // A rule whose origin nobody knows is one nobody dares remove.
    expect(created.body.sourceCardId).toBe('card-7');
  });

  it('can be removed', async () => {
    const created = await json<{ id: string }>('POST', `/api/boards/${boardId}/invariants`, {
      statement: 'Temporary rule.',
    });

    expect(
      (await json('DELETE', `/api/boards/${boardId}/invariants/${created.body.id}`)).status,
    ).toBe(204);
    expect((await json<unknown[]>('GET', `/api/boards/${boardId}/invariants`)).body).toHaveLength(
      0,
    );
  });
});

describe('what a dispatched card is told', () => {
  it('separates project rules from the card’s own', () => {
    const context = renderCardContext({
      title: 'A card',
      body: 'Do the thing.',
      guardrails: { ...EMPTY_GUARDRAILS, prohibit: ['src/db/schema.ts'] },
      invariants: ['Every migration must be additive.'],
    });

    // An agent that cannot tell the two apart will either treat a standing rule
    // as this task's peculiarity, or carry this task's peculiarity into the next
    // card as though it were standing.
    expect(context).toContain('Rules for this project, true of every card');
    expect(context).toContain('Every migration must be additive.');
    expect(context).toContain('Constraints');
    expect(context).toContain('src/db/schema.ts');
  });

  it('says nothing about project rules when there are none', () => {
    const context = renderCardContext({
      title: 'A card',
      body: '',
      guardrails: EMPTY_GUARDRAILS,
      invariants: [],
    });

    expect(context).not.toContain('Rules for this project');
  });
});

describe('noticing that a card rule has become a project rule', () => {
  async function cardWithRule(title: string, prohibit: readonly string[]): Promise<string> {
    const created = await json<{ id: string }>('POST', `/api/boards/${boardId}/cards`, { title });
    await json('PATCH', `/api/cards/${created.body.id}`, { guardrails: { prohibit } });
    return created.body.id;
  }

  async function proposals(): Promise<{ statement: string; cards: unknown[] }[]> {
    return (
      await json<{ statement: string; cards: unknown[] }[]>(
        'GET',
        `/api/boards/${boardId}/invariant-proposals`,
      )
    ).body;
  }

  it('proposes a rule three cards already carry', async () => {
    for (const title of ['a', 'b', 'c']) await cardWithRule(title, ['src/db/schema.ts']);

    expect((await proposals()).map((entry) => entry.statement)).toEqual(['src/db/schema.ts']);
  });

  it('says nothing about a rule only two cards carry', async () => {
    // Two cards sharing a rule is ordinary: they are usually one piece of work
    // split in half. Three is where it stops being about those cards.
    for (const title of ['a', 'b']) await cardWithRule(title, ['src/db/schema.ts']);

    expect(await proposals()).toEqual([]);
  });

  it('matches wording rather than the exact string', async () => {
    await cardWithRule('a', ['Never edit the schema.']);
    await cardWithRule('b', ['never edit the schema']);
    await cardWithRule('c', ['Never  edit the schema']);

    // The same rule typed by hand onto three cards is three spellings of it,
    // and an exact match would miss the case that motivates the feature.
    expect(await proposals()).toHaveLength(1);
  });

  it('stops proposing one that is already a project rule', async () => {
    for (const title of ['a', 'b', 'c']) await cardWithRule(title, ['src/db/schema.ts']);
    await json('POST', `/api/boards/${boardId}/invariants`, { statement: 'src/db/schema.ts' });

    expect(await proposals()).toEqual([]);
  });

  it('names the cards that carry it', async () => {
    for (const title of ['first', 'second', 'third']) await cardWithRule(title, ['rule']);

    // The claim is falsifiable and the operator may disagree with it, so the
    // evidence travels with the proposal.
    expect((await proposals())[0]?.cards).toHaveLength(3);
  });

  it('leaves verify commands alone', async () => {
    for (const title of ['a', 'b', 'c']) {
      const created = await json<{ id: string }>('POST', `/api/boards/${boardId}/cards`, { title });
      await json('PATCH', `/api/cards/${created.body.id}`, {
        guardrails: { verify: 'npm test' },
      });
    }

    // A verify command is a property of the card's own work. Hoisting one to
    // the project imposes one card's check on every other card.
    expect(await proposals()).toEqual([]);
  });
});
