import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '../src/server/app.js';
import { openDatabase, type DatabaseHandle } from '../src/server/db/client.js';
import { events, runs } from '../src/server/db/schema.js';

import { classify, describeWait, DEFAULT_WINDOW_MS } from '../src/server/cards/activity.js';

/**
 * News against backlog in the digest (doc 18, U6).
 *
 * The digest claims to answer "what happened while I was asleep". Without this
 * split it does not: a card blocked for three days appears exactly as one that
 * failed an hour ago, so the list only grows and the claim becomes false. An
 * operator who reads a standing backlog every morning learns to skim the one
 * screen written to be read carefully.
 */

const NOW = Date.UTC(2026, 7, 20, 8, 0, 0);
const CUTOFF = NOW - DEFAULT_WINDOW_MS;

describe('deciding what is news', () => {
  it('counts activity inside the window as having moved', () => {
    expect(classify(NOW - 3_600_000, CUTOFF, NOW).recency).toBe('moved');
  });

  it('counts activity before the window as waiting', () => {
    const verdict = classify(NOW - 5 * 86_400_000, CUTOFF, NOW);

    expect(verdict.recency).toBe('waiting');
    expect(verdict.waitingForMs).toBe(5 * 86_400_000);
  });

  it('separates a card that never ran from one that ran and stopped', () => {
    // They need different actions: one is waiting on the operator to dispatch
    // it, the other on the operator to read it.
    expect(classify(null, CUTOFF, NOW).recency).toBe('never-ran');
    expect(classify(null, CUTOFF, NOW).waitingForMs).toBeNull();
  });

  it('treats the cutoff itself as inside the window', () => {
    // A card that moved at exactly the moment the window opens is news. The
    // other choice hides the first thing that happened after the operator left.
    expect(classify(CUTOFF, CUTOFF, NOW).recency).toBe('moved');
  });

  it('uses an overnight rather than a full day', () => {
    // Sixteen hours: someone who left at six in the evening and reads this at
    // eight should see the evening's work as news, and yesterday morning's as
    // backlog. A full day folds the two together from the other direction.
    expect(DEFAULT_WINDOW_MS).toBe(16 * 60 * 60 * 1_000);
  });
});

describe('saying how long', () => {
  it('rounds a short wait to hours', () => {
    expect(describeWait(5 * 3_600_000)).toBe('5 hours');
    expect(describeWait(3_600_000)).toBe('1 hour');
  });

  it('switches to days once hours stop meaning anything', () => {
    expect(describeWait(3 * 86_400_000)).toBe('3 days');
  });

  it('does not report a fraction of an hour as zero', () => {
    // "0 hours" reads as a bug. The card did move; it moved recently.
    expect(describeWait(600_000)).toBe('under an hour');
  });
});

/**
 * The endpoint, where the classification meets real events.
 *
 * The ordering assertion is the one that matters: the standing backlog is real
 * work and must not disappear, but it is not news, and it is not what the
 * operator opened this screen to find out.
 */
describe('GET /api/boards/:boardId/digest', () => {
  let dir: string;
  let database: DatabaseHandle;
  let app: FastifyInstance;
  let boardId: string;
  let seq = 0;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'gorilla-digest-'));
    database = openDatabase({ path: join(dir, 'digest.db') });
    app = buildApp({ database, logger: false });
    await app.ready();
    seq = 0;

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

  /** A card whose last event landed at a given moment. */
  async function cardActiveAt(title: string, at: number | null): Promise<string> {
    const created = await app.inject({
      method: 'POST',
      url: `/api/boards/${boardId}/cards`,
      payload: { title },
    });
    const cardId = (created.json() as { id: string }).id;

    // Only an active card reaches the digest at all.
    await app.inject({
      method: 'PATCH',
      url: `/api/cards/${cardId}`,
      payload: { status: 'awaiting-review' },
    });

    if (at !== null) {
      const runId = randomUUID();
      database.db
        .insert(runs)
        .values({
          id: runId,
          boardId,
          cardId,
          sessionId: randomUUID(),
          cwd: dir,
          startedAt: at,
        })
        .run();

      seq += 1;
      database.db
        .insert(events)
        .values({
          runId,
          sessionId: randomUUID(),
          seq,
          eventName: 'Stop',
          receivedAt: at,
          payload: JSON.stringify({ cwd: dir }),
        })
        .run();
    }

    return cardId;
  }

  const digest = async (): Promise<{
    since: number;
    entries: {
      cardId: string;
      recency: string;
      waitedFor: string | null;
      spent: number | null;
      contradictions: number;
    }[];
  }> => (await app.inject({ method: 'GET', url: `/api/boards/${boardId}/digest` })).json();

  it('marks a card that moved last night as news', async () => {
    const recent = await cardActiveAt('moved overnight', Date.now() - 3_600_000);

    const body = await digest();
    expect(body.entries.find((entry) => entry.cardId === recent)?.recency).toBe('moved');
  });

  it('marks a card that has sat for days as backlog, and says how long', async () => {
    const old = await cardActiveAt('blocked since Tuesday', Date.now() - 4 * 86_400_000);

    const entry = (await digest()).entries.find((candidate) => candidate.cardId === old);
    expect(entry?.recency).toBe('waiting');
    expect(entry?.waitedFor).toBe('4 days');
  });

  it('puts news above backlog even when the backlog is more urgent', async () => {
    await cardActiveAt('blocked since Tuesday', Date.now() - 4 * 86_400_000);
    const recent = await cardActiveAt('moved overnight', Date.now() - 3_600_000);

    // The backlog card is real work. It is not what this screen is for.
    expect((await digest()).entries[0]?.cardId).toBe(recent);
  });

  it('reports the window it used', async () => {
    await cardActiveAt('anything', Date.now());

    const body = await digest();
    expect(body.since).toBeLessThan(Date.now());
    expect(body.since).toBeGreaterThan(Date.now() - DEFAULT_WINDOW_MS - 60_000);
  });

  it('honours a window the caller asks for', async () => {
    const card = await cardActiveAt('two hours ago', Date.now() - 2 * 3_600_000);

    const response = await app.inject({
      method: 'GET',
      url: `/api/boards/${boardId}/digest?since=${String(Date.now() - 3_600_000)}`,
    });
    const body = response.json() as { entries: { cardId: string; recency: string }[] };

    // Same card, narrower window: what counts as news is a question about the
    // period, not about the card.
    expect(body.entries.find((entry) => entry.cardId === card)?.recency).toBe('waiting');
  });

  it('calls a card that never ran neither news nor backlog', async () => {
    const never = await cardActiveAt('dispatched nothing', null);

    expect((await digest()).entries.find((entry) => entry.cardId === never)?.recency).toBe(
      'never-ran',
    );
  });

  describe('the signals added after it was written', () => {
    it('says what a card cost, when anything recorded it', async () => {
      const cardId = await cardActiveAt('spent something', Date.now() - 3_600_000);

      database.db
        .insert(runs)
        .values({
          id: randomUUID(),
          boardId,
          cardId,
          sessionId: randomUUID(),
          cwd: dir,
          startedAt: Date.now(),
          inputTokens: 4_000,
          costSource: 'result',
        })
        .run();

      expect((await digest()).entries.find((entry) => entry.cardId === cardId)?.spent).toBe(4_000);
    });

    it('says nothing rather than zero when no run recorded usage', async () => {
      const cardId = await cardActiveAt('unrecorded', Date.now() - 3_600_000);

      // A card whose runs reported no usage and one that cost nothing are
      // different facts, and this screen is read at speed by somebody deciding
      // what to look at first.
      expect((await digest()).entries.find((entry) => entry.cardId === cardId)?.spent).toBeNull();
    });
  });
});
