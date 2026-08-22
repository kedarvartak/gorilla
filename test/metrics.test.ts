import { mkdtempSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createCard } from '../src/server/api/cards.js';
import { createDefaultColumns } from '../src/server/cards/defaults.js';
import { openDatabase, type DatabaseHandle } from '../src/server/db/client.js';
import { boards, cards, runs } from '../src/server/db/schema.js';
import { describeMetrics, readMetrics } from '../src/server/metrics.js';
import { eq } from 'drizzle-orm';

/**
 * Whether the board is getting anywhere (T59, T60).
 *
 * Every fact needed to answer this has been recorded for months and nothing
 * has read it back.
 */

let dir: string;
let handle: DatabaseHandle;
const BOARD = 'board-1';
const DAY = 24 * 60 * 60 * 1_000;

function card(title: string, options: { createdAt?: number; mergedAt?: number } = {}): string {
  const created = createCard(handle, { boardId: BOARD, title });

  if (options.createdAt !== undefined || options.mergedAt !== undefined) {
    handle.db
      .update(cards)
      .set({
        ...(options.createdAt === undefined ? {} : { createdAt: options.createdAt }),
        ...(options.mergedAt === undefined ? {} : { mergedAt: options.mergedAt }),
      })
      .where(eq(cards.id, created.id))
      .run();
  }

  return created.id;
}

function run(cardId: string, endReason: string, startedAt = Date.now()): void {
  handle.db
    .insert(runs)
    .values({
      id: randomUUID(),
      boardId: BOARD,
      cardId,
      sessionId: randomUUID(),
      startedAt,
      endedAt: startedAt + 1_000,
      endReason,
      cwd: dir,
    })
    .run();
}

function priced(cardId: string, tokens: number, costUsd: number, startedAt = Date.now()): void {
  handle.db
    .insert(runs)
    .values({
      id: randomUUID(),
      boardId: BOARD,
      cardId,
      sessionId: randomUUID(),
      startedAt,
      cwd: dir,
      inputTokens: tokens,
      outputTokens: 0,
      costUsd,
      costSource: 'result',
    })
    .run();
}

function metrics(sinceDaysAgo = 30) {
  return readMetrics(handle.sqlite, BOARD, Date.now() - sinceDaysAgo * DAY);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gorilla-metrics-'));
  handle = openDatabase({ path: join(dir, 'm.db') });
  handle.db.insert(boards).values({ id: BOARD, name: 'b', cwd: dir, createdAt: 1 }).run();
  createDefaultColumns(handle.db, BOARD);
});

afterEach(() => {
  handle.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('throughput', () => {
  it('counts what was added and what merged', () => {
    const now = Date.now();
    card('merged one', { createdAt: now - 2 * DAY, mergedAt: now - DAY });
    card('still open');

    expect(metrics().throughput.merged).toBe(1);
    expect(metrics().throughput.created).toBe(2);
  });

  it('measures from when the card was written, not from when it ran', () => {
    const now = Date.now();
    card('slow to start', { createdAt: now - 10 * DAY, mergedAt: now - DAY });

    // A measure starting at dispatch would report a board that never got round
    // to a card as fast.
    expect(metrics().throughput.medianLeadTimeMs).toBe(9 * DAY);
  });

  it('takes a median, not a mean', () => {
    const now = Date.now();
    card('a', { createdAt: now - 2 * DAY, mergedAt: now - DAY });
    card('b', { createdAt: now - 3 * DAY, mergedAt: now - 2 * DAY });
    card('c', { createdAt: now - 25 * DAY, mergedAt: now - DAY });

    // One card that sat for three weeks moves a mean enough to make a good
    // week look bad.
    expect(metrics().throughput.medianLeadTimeMs).toBe(DAY);
  });

  it('reports no lead time rather than zero when nothing merged', () => {
    card('never merged');

    // Nothing merged is a different fact from merging instantly, and the more
    // interesting one.
    expect(metrics().throughput.medianLeadTimeMs).toBeNull();
    expect(describeMetrics(metrics()).join(' ')).toContain('no lead time');
  });

  it('ignores what merged before the window', () => {
    const now = Date.now();
    card('old', { createdAt: now - 90 * DAY, mergedAt: now - 60 * DAY });

    expect(metrics(30).throughput.merged).toBe(0);
  });
});

describe('what actually breaks', () => {
  it('counts endings by cause, commonest first', () => {
    const a = card('a');
    const b = card('b');
    const c = card('c');
    run(a, 'verify-failed');
    run(b, 'verify-failed');
    run(c, 'session ended');

    expect(metrics().failures[0]).toEqual({ reason: 'verify-failed', cards: 2 });
  });

  it('counts a card once however many times it failed', () => {
    const a = card('a');
    run(a, 'verify-failed');
    run(a, 'verify-failed');

    // Otherwise one card retried five times looks like five broken cards.
    expect(metrics().failures[0]?.cards).toBe(1);
  });

  it('says which failure is common, not which is memorable', () => {
    const a = card('a');
    run(a, 'verify-failed');

    expect(describeMetrics(metrics()).join(' ')).toContain('Most common ending');
  });
});

describe('cards nobody has started', () => {
  it('counts them separately from throughput', () => {
    card('never run');

    // A board with forty cards nobody has started is not a slow board, it is a
    // full one, and the two call for different responses.
    expect(metrics().neverRan).toBe(1);
    expect(describeMetrics(metrics()).join(' ')).toContain('never run at all');
  });
});

describe('what each day cost', () => {
  it('groups runs by the day they started', () => {
    const now = Date.now();
    run(card('a'), 'session ended', now);
    run(card('b'), 'session ended', now - 2 * DAY);

    expect(metrics().spendByDay).toHaveLength(2);
  });

  it('adds up the tokens', () => {
    const id = card('a');
    priced(id, 1_000, 0.5);
    priced(id, 500, 0.25);

    const today = metrics().spendByDay.at(-1);
    expect(today?.tokens).toBe(1_500);
    expect(today?.costUsd).toBeCloseTo(0.75);
  });

  it('reports null rather than zero for a day nobody priced', () => {
    const id = card('a');
    run(id, 'session ended');

    // A day that cost nothing and a day nobody priced are different, and a
    // chart drawing both at the floor would say the wrong one.
    expect(metrics().spendByDay.at(-1)?.costUsd).toBeNull();
  });

  it('says how much of the window was priced', () => {
    const id = card('a');
    priced(id, 1_000, 2);
    run(card('b'), 'session ended', Date.now() - DAY);

    const note = describeMetrics(metrics()).join(' ');
    expect(note).toContain('$2.00');
    expect(note).toContain('1 of 2 days');
  });
});
