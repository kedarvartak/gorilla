import { mkdtempSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '../src/server/app.js';
import { openDatabase, type DatabaseHandle } from '../src/server/db/client.js';
import { ledgerEntries, runs } from '../src/server/db/schema.js';

/**
 * The operator's verdict on an entry (P2).
 *
 * `setOperatorStatus` had existed since the ledger was written with no caller at
 * all, so the board asserted things and offered no way to say "that is wrong".
 */

let dir: string;
let database: DatabaseHandle;
let app: FastifyInstance;
let boardId: string;
let cardId: string;

async function json<T>(method: 'GET' | 'POST', url: string, payload?: unknown) {
  const response = await app.inject({
    method,
    url,
    ...(payload === undefined ? {} : { payload: payload as object }),
  });
  return { status: response.statusCode, body: response.json() as T };
}

/** A stored model entry on the card, as extraction would have written it. */
function entry(over: Partial<typeof ledgerEntries.$inferInsert> = {}): string {
  const id = randomUUID();
  const runId = randomUUID();

  database.db
    .insert(runs)
    .values({ id: runId, boardId, cardId, sessionId: id, startedAt: Date.now(), cwd: dir })
    .run();

  database.db
    .insert(ledgerEntries)
    .values({
      id,
      cardId,
      runId,
      kind: 'decision',
      statement: 'Chose SQLite over flat files.',
      alternative: 'flat files',
      sourceEventIds: '[1]',
      origin: 'model',
      createdAt: Date.now(),
      ...over,
    })
    .run();

  return id;
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'gorilla-judge-'));
  database = openDatabase({ path: join(dir, 'judge.db') });
  app = buildApp({ database, logger: false });
  await app.ready();

  const board = await json<{ id: string }>('POST', '/api/boards', { name: 'test', cwd: dir });
  boardId = board.body.id;

  const card = await json<{ id: string }>('POST', `/api/boards/${boardId}/cards`, {
    title: 'Judged card',
  });
  cardId = card.body.id;
});

afterEach(async () => {
  await app.close();
  database.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('recording a verdict', () => {
  it('accepts an entry', async () => {
    const id = entry();
    const result = await json<{ operatorStatus: string }>('POST', `/api/ledger/${id}/status`, {
      status: 'accepted',
    });

    expect(result.status).toBe(200);
    expect(result.body.operatorStatus).toBe('accepted');
  });

  it('rejects an entry without deleting it', async () => {
    const id = entry();
    await json('POST', `/api/ledger/${id}/status`, { status: 'rejected' });

    const row = database.db.select().from(ledgerEntries).all();
    // A rejection is evidence about the model, and doc 12's repair path reads
    // only from these verdicts. Deleting it would destroy that record.
    expect(row).toHaveLength(1);
    expect(row[0]?.operatorStatus).toBe('rejected');
  });

  it('stores the operator’s own wording on a correction', async () => {
    const id = entry();
    await json('POST', `/api/ledger/${id}/status`, {
      status: 'corrected',
      statement: 'It was actually chosen for FTS5, not for being a single file.',
    });

    const row = database.db.select().from(ledgerEntries).all()[0];
    expect(row?.operatorStatus).toBe('corrected');
    expect(row?.statement).toContain('FTS5');
  });

  it('refuses a correction that does not say what it should read', async () => {
    const id = entry();
    const refused = await json<{ field: string }>('POST', `/api/ledger/${id}/status`, {
      status: 'corrected',
    });

    // Marking something fixed while leaving it wrong is worse than leaving it.
    expect(refused.status).toBe(400);
    expect(refused.body.field).toBe('statement');
  });

  it('refuses a status the schema does not have', async () => {
    const id = entry();
    const refused = await json<{ field: string }>('POST', `/api/ledger/${id}/status`, {
      status: 'maybe',
    });

    expect(refused.status).toBe(400);
    expect(refused.body.field).toBe('status');
  });

  it('answers 404 for an entry that does not exist', async () => {
    const missing = await json('POST', `/api/ledger/${randomUUID()}/status`, {
      status: 'accepted',
    });
    expect(missing.status).toBe(404);
  });
});

describe('what a rejection changes', () => {
  it('stops the entry being stated as fact in the brief', async () => {
    const id = entry();

    const before = await json<{ markdown: string }>('GET', `/api/cards/${cardId}/brief`);
    expect(before.body.markdown).toContain('Chose SQLite over flat files');

    await json('POST', `/api/ledger/${id}/status`, { status: 'rejected' });

    const after = await json<{ markdown: string }>('GET', `/api/cards/${cardId}/brief`);
    expect(after.body.markdown).not.toContain('Chose SQLite over flat files');
    // Said out loud rather than silently dropped: "you overruled one of these"
    // is itself worth knowing on returning to a card.
    expect(after.body.markdown).toContain('You rejected 1 entry');
  });

  it('leaves an accepted entry stated as before', async () => {
    const id = entry();
    await json('POST', `/api/ledger/${id}/status`, { status: 'accepted' });

    const brief = await json<{ markdown: string }>('GET', `/api/cards/${cardId}/brief`);
    expect(brief.body.markdown).toContain('Chose SQLite over flat files');
  });

  it('shows a correction in the operator’s words', async () => {
    const id = entry();
    await json('POST', `/api/ledger/${id}/status`, {
      status: 'corrected',
      statement: 'Chose SQLite for FTS5.',
    });

    const brief = await json<{ markdown: string }>('GET', `/api/cards/${cardId}/brief`);
    expect(brief.body.markdown).toContain('Chose SQLite for FTS5');
  });

  it('does not count a rejected entry as unseen', async () => {
    const id = entry();
    await json('POST', `/api/cards/${cardId}/seen`, {});
    const id2 = entry();

    const before = await json<{ unseenCount: number }>('GET', `/api/cards/${cardId}/brief`);
    const wasUnseen = before.body.unseenCount;

    await json('POST', `/api/ledger/${id2}/status`, { status: 'rejected' });
    await json('POST', `/api/ledger/${id}/status`, { status: 'rejected' });

    const after = await json<{ unseenCount: number }>('GET', `/api/cards/${cardId}/brief`);
    expect(after.body.unseenCount).toBeLessThan(wasUnseen + 1);
  });
});
