import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '../src/server/app.js';
import { openDatabase, type DatabaseHandle } from '../src/server/db/client.js';
import { reorderColumns } from '../src/server/cards/column-order.js';

/**
 * Rearranging the pipeline.
 *
 * Column order is the sequence work moves through and the dispatcher reads it,
 * so it lives in the database rather than in one browser. The assertions here
 * are about the two things that make that hard: `(board_id, position)` is
 * unique, so a permutation cannot be written in a loop; and a caller holding a
 * stale board must be refused rather than quietly obeyed.
 */

let dir: string;
let database: DatabaseHandle;
let app: FastifyInstance;
let boardId: string;

async function columnIds(): Promise<string[]> {
  const response = await app.inject({ method: 'GET', url: `/api/boards/${boardId}/columns` });
  return (response.json() as { id: string }[]).map((column) => column.id);
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'gorilla-columns-'));
  database = openDatabase({ path: join(dir, 'columns.db') });
  app = buildApp({ database, logger: false });
  await app.ready();

  const board = await app.inject({
    method: 'POST',
    url: '/api/boards',
    payload: { name: 'kanban', cwd: dir },
  });
  boardId = (board.json() as { id: string }).id;
});

afterEach(async () => {
  await app.close();
  database.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('reordering columns', () => {
  it('writes the order it was given', async () => {
    const before = await columnIds();
    const wanted = [...before].reverse();

    const response = await app.inject({
      method: 'PATCH',
      url: `/api/boards/${boardId}/columns`,
      payload: { order: wanted },
    });

    expect(response.statusCode).toBe(200);
    expect(await columnIds()).toEqual(wanted);
  });

  it('survives a permutation whose positions collide pairwise', async () => {
    // Swapping the first two columns asks for position 0 while another row
    // still holds it. `(board_id, position)` is unique, so a straight loop
    // fails here and nowhere else - which is exactly the sort of bug that
    // ships because the reversal case was the only one anybody tried.
    const before = await columnIds();
    const swapped = [before[1], before[0], ...before.slice(2)] as string[];

    const response = await app.inject({
      method: 'PATCH',
      url: `/api/boards/${boardId}/columns`,
      payload: { order: swapped },
    });

    expect(response.statusCode).toBe(200);
    expect(await columnIds()).toEqual(swapped);
  });

  it('leaves the order alone when it is asked for the order it already has', async () => {
    const before = await columnIds();

    await app.inject({
      method: 'PATCH',
      url: `/api/boards/${boardId}/columns`,
      payload: { order: before },
    });

    expect(await columnIds()).toEqual(before);
  });

  it('renumbers to consecutive positions rather than leaving gaps', async () => {
    const before = await columnIds();
    await app.inject({
      method: 'PATCH',
      url: `/api/boards/${boardId}/columns`,
      payload: { order: [...before].reverse() },
    });

    const response = await app.inject({ method: 'GET', url: `/api/boards/${boardId}/columns` });
    const positions = (response.json() as { position: number }[]).map((row) => row.position);

    // The parking pass writes large negatives. One that survived would sort
    // correctly today and collide with the next board-level insert.
    expect(positions).toEqual(positions.map((_, index) => index));
  });
});

describe('refusing an order that cannot be trusted', () => {
  it('refuses a list missing a column', async () => {
    const before = await columnIds();

    const response = await app.inject({
      method: 'PATCH',
      url: `/api/boards/${boardId}/columns`,
      payload: { order: before.slice(0, 2) },
    });

    // Appending the rest would move columns nobody dragged. The caller has a
    // stale board and should be told so.
    expect(response.statusCode).toBe(400);
    expect(await columnIds()).toEqual(before);
  });

  it('refuses a column that belongs to another board', async () => {
    const other = await app.inject({
      method: 'POST',
      url: '/api/boards',
      payload: { name: 'other', cwd: join(dir, 'other') },
    });
    const otherId = (other.json() as { id: string }).id;
    const otherColumns = await app.inject({ method: 'GET', url: `/api/boards/${otherId}/columns` });
    const foreign = (otherColumns.json() as { id: string }[])[0]?.id ?? '';

    const before = await columnIds();
    const response = await app.inject({
      method: 'PATCH',
      url: `/api/boards/${boardId}/columns`,
      payload: { order: [foreign, ...before.slice(1)] },
    });

    expect(response.statusCode).toBe(400);
    expect(await columnIds()).toEqual(before);
  });

  it('refuses a list that names one column twice', async () => {
    const before = await columnIds();
    const first = before[0] ?? '';

    const response = await app.inject({
      method: 'PATCH',
      url: `/api/boards/${boardId}/columns`,
      payload: { order: [first, ...before] },
    });

    // Right length, wrong contents. Counting alone would let this through and
    // drop whichever column the duplicate displaced.
    expect(response.statusCode).toBe(400);
    expect(await columnIds()).toEqual(before);
  });

  it('refuses anything that is not a list of ids', async () => {
    for (const order of [undefined, 'first', 7, [1, 2, 3]]) {
      const response = await app.inject({
        method: 'PATCH',
        url: `/api/boards/${boardId}/columns`,
        payload: { order },
      });
      expect(response.statusCode).toBe(400);
    }
  });

  it('says so rather than throwing when the board has no columns', () => {
    const result = reorderColumns(database, 'no-such-board', []);

    expect(result.ok).toBe(false);
    expect(result.error).toContain('no columns');
  });
});
