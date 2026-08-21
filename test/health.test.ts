import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '../src/server/app.js';
import { createCard, updateCard } from '../src/server/api/cards.js';
import { createDefaultColumns } from '../src/server/cards/defaults.js';
import { openDatabase, type DatabaseHandle } from '../src/server/db/client.js';
import { boards } from '../src/server/db/schema.js';
import type { Health } from '../src/server/health.js';

/**
 * What the board is doing, in one request (T44).
 *
 * The endpoint used to return a hardcoded `ok`. A monitor built on that
 * reported a healthy board while the queue was halted, every card was blocked,
 * and no event had arrived in six hours.
 */

let dir: string;
let database: DatabaseHandle;
let app: FastifyInstance;
const BOARD = 'board-1';

async function health(): Promise<Health> {
  const response = await app.inject({ method: 'GET', url: '/health' });
  return response.json<Health>();
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'gorilla-health-'));
  database = openDatabase({ path: join(dir, 'h.db') });
  database.db.insert(boards).values({ id: BOARD, name: 'the board', cwd: dir, createdAt: 1 }).run();
  createDefaultColumns(database.db, BOARD);

  app = buildApp({ database, logger: false });
  await app.ready();
});

afterEach(async () => {
  await app.close();
  database.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('reporting what the board is doing', () => {
  it('counts what is waiting and what is stuck', async () => {
    createCard(database, { boardId: BOARD, title: 'waiting' });
    const stuck = createCard(database, { boardId: BOARD, title: 'stuck' });
    updateCard(database, stuck.id, { status: 'blocked' });

    const body = await health();

    expect(body.boards[0]?.queued).toBe(1);
    expect(body.boards[0]?.blocked).toBe(1);
  });

  it('names the board rather than only its id', async () => {
    // A monitor that can only report a uuid makes the operator look up which
    // board it meant before they can act on it.
    expect((await health()).boards[0]?.name).toBe('the board');
  });

  it('says no event has ever arrived, rather than saying none recently', async () => {
    // These are different facts. The first usually means the hooks are
    // pointing at a different port, which is a fixable configuration problem;
    // the second means the board is quiet.
    expect((await health()).lastEventAt).toBeNull();
  });

  it('is ok when nothing is halted', async () => {
    expect((await health()).status).toBe('ok');
  });

  it('asks for attention when a queue is halted', async () => {
    // A card with no goal condition cannot be dispatched, and the dispatcher
    // records why rather than throwing - which makes it the cheapest real halt
    // to produce here.
    const card = createCard(database, { boardId: BOARD, title: 'no goal' });
    await app.inject({
      method: 'POST',
      url: `/api/boards/${BOARD}/cards/${card.id}/dispatch`,
    });

    const body = await health();

    // Attention, not 'unhealthy'. A halted queue is usually the gate working:
    // it stopped for something that needs a person. Calling that a failure
    // teaches the operator to ignore the signal.
    expect(body.status).toBe('attention');
    expect(body.boards[0]?.halted?.cardTitle).toBe('no goal');
  });

  it('reports uptime, so a monitor can see a board that keeps restarting', async () => {
    expect((await health()).uptimeMs).toBeGreaterThanOrEqual(0);
  });
});
