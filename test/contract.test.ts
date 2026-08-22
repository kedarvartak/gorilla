import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '../src/server/app.js';
import { createCard } from '../src/server/api/cards.js';
import { createDefaultColumns } from '../src/server/cards/defaults.js';
import { openDatabase, type DatabaseHandle } from '../src/server/db/client.js';
import { boards } from '../src/server/db/schema.js';

/**
 * The shape of what the API answers with (T3).
 *
 * The interface reads these responses field by field, and nothing connected
 * the two. Renaming a field was a green test suite and a blank panel - which
 * is how six web tests came to fail on a field they had never heard of, twice
 * in one week.
 *
 * These are shape assertions, not value assertions. A test that pins the
 * values is a test that has to be edited every time the fixtures change, and
 * one that gets edited routinely stops being read.
 */

let dir: string;
let database: DatabaseHandle;
let app: FastifyInstance;
const BOARD = 'board-1';
let cardId: string;

/** The type skeleton of a value: keys and the kinds of thing behind them. */
function shapeOf(value: unknown): unknown {
  if (Array.isArray(value)) return value.length === 0 ? ['?'] : [shapeOf(value[0])];
  if (value === null) return 'null';
  if (typeof value !== 'object') return typeof value;

  const shape: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    shape[key] = shapeOf((value as Record<string, unknown>)[key]);
  }
  return shape;
}

async function shapeAt(url: string): Promise<unknown> {
  const response = await app.inject({ method: 'GET', url });
  expect(response.statusCode, `${url} answered ${String(response.statusCode)}`).toBe(200);
  return shapeOf(response.json());
}

function keysAt(shape: unknown): string[] {
  return typeof shape === 'object' && shape !== null && !Array.isArray(shape)
    ? Object.keys(shape)
    : [];
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'gorilla-contract-'));
  database = openDatabase({ path: join(dir, 'c.db') });
  database.db.insert(boards).values({ id: BOARD, name: 'b', cwd: dir, createdAt: 1 }).run();
  createDefaultColumns(database.db, BOARD);
  cardId = createCard(database, { boardId: BOARD, title: 'a card' }).id;

  app = buildApp({ database, logger: false });
  await app.ready();
});

afterEach(async () => {
  await app.close();
  database.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('the route inventory', () => {
  it('has not grown without anybody noticing', () => {
    const printed = app.printRoutes({ commonPrefix: false });
    const routes = printed.split('\n').filter((line) => line.includes('(')).length;

    // Not an exact number: this is a tripwire, not a specification. A route
    // added without a thought about its shape trips it, and the fix is either
    // a contract assertion below or a raised bound with a reason.
    expect(routes).toBeGreaterThan(30);
    expect(routes).toBeLessThan(60);
  });
});

describe('what a board answers with', () => {
  it('lists boards', async () => {
    expect(keysAt(((await shapeAt('/api/boards')) as unknown[])[0])).toEqual([
      'createdAt',
      'cwd',
      'dailyTokenBudget',
      'dispatchFromHour',
      'dispatchToHour',
      'id',
      'name',
    ]);
  });

  it('reports dispatch state with its spend', async () => {
    expect(keysAt(await shapeAt(`/api/boards/${BOARD}/dispatch`))).toEqual([
      'budget',
      'completed',
      'concurrency',
      'failureStreak',
      'halted',
      'holdingFor',
      'mode',
      'policy',
      'running',
      'spend',
      'spendNote',
    ]);
  });

  it('reports health as facts, not a verdict alone', async () => {
    expect(keysAt(await shapeAt('/health'))).toEqual([
      'boards',
      'build',
      'lastEventAt',
      'status',
      'uptimeMs',
    ]);
  });

  it('reports metrics with the notes that explain them', async () => {
    expect(keysAt(await shapeAt(`/api/boards/${BOARD}/metrics`))).toEqual([
      'failures',
      'neverRan',
      'notes',
      'since',
      'throughput',
    ]);
  });

  it('reports a digest as a window, not a bare list', async () => {
    // It was a bare array until G10. Anything reading it has to be able to
    // tell what changed overnight from what was already waiting.
    expect(keysAt(await shapeAt(`/api/boards/${BOARD}/digest`))).toEqual([
      'entries',
      'generatedAt',
      'since',
    ]);
  });
});

describe('what a card answers with', () => {
  it('carries everything the detail pane reads', async () => {
    const shape = await shapeAt(`/api/cards/${cardId}/detail`);

    // The list the interface actually depends on. A field disappearing from
    // here is a blank panel, and this is the test that says so first.
    expect(keysAt(shape)).toEqual([
      'blastRadius',
      'blockers',
      'card',
      'claimedNotInGit',
      'diff',
      'guardrailDetail',
      'guardrails',
      'mergeForecast',
      'mergeTarget',
      'reality',
      'realityNotes',
      'relatedCards',
      'runs',
      'staleness',
      'subsystems',
      'verify',
      'verifyCommand',
      'verifyNote',
      'workspace',
    ]);
  });

  it('answers a proposals request with a list', async () => {
    expect(await shapeAt(`/api/cards/${cardId}/guardrail-proposals`)).toEqual(['?']);
  });

  it('answers a subagents request with a list', async () => {
    expect(await shapeAt(`/api/cards/${cardId}/subagents`)).toEqual(['?']);
  });
});
