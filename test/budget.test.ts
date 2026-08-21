import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDatabase, type DatabaseHandle } from '../src/server/db/client.js';
import { boards, runs } from '../src/server/db/schema.js';
import {
  describeSpend,
  overBudget,
  spentSince,
  startOfDay,
  NOTHING_SPENT,
} from '../src/server/dispatch/budget.js';

/**
 * What a board has spent today (T27).
 *
 * The per-card ceiling stops one runaway run. This is about the other shape an
 * overnight batch takes: fifty reasonable cards, nothing individually
 * alarming, and a bill in the morning.
 */

let dir: string;
let handle: DatabaseHandle;
const BOARD = 'board-1';

function run(startedAt: number, tokens: number | null): void {
  handle.db
    .insert(runs)
    .values({
      id: randomUUID(),
      boardId: BOARD,
      sessionId: randomUUID(),
      startedAt,
      cwd: dir,
      ...(tokens === null
        ? {}
        : { inputTokens: tokens, outputTokens: 0, costSource: 'result' as const }),
    })
    .run();
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gorilla-budget-'));
  handle = openDatabase({ path: join(dir, 'budget.db') });
  handle.db.insert(boards).values({ id: BOARD, name: 'b', cwd: dir, createdAt: 1 }).run();
});

afterEach(() => {
  handle.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('counting a day’s spend', () => {
  it('adds up every recorded run since the cutoff', () => {
    const now = Date.now();
    run(now - 1_000, 500);
    run(now - 2_000, 1_500);

    expect(spentSince(handle.sqlite, BOARD, now - 10_000).tokens).toBe(2_000);
  });

  it('ignores runs from before the cutoff', () => {
    const now = Date.now();
    run(now - 100_000, 9_000);
    run(now - 1_000, 500);

    expect(spentSince(handle.sqlite, BOARD, now - 10_000).tokens).toBe(500);
  });

  it('counts a run that recorded nothing as unrecorded, not as zero', () => {
    const now = Date.now();
    run(now - 1_000, 500);
    run(now - 1_000, null);

    const spend = spentSince(handle.sqlite, BOARD, now - 10_000);

    // The honest claim is "at least 500". An operator who does not know a run
    // is missing cannot tell a reliable total from a mostly-blank one.
    expect(spend.tokens).toBe(500);
    expect(spend.runs).toBe(2);
    expect(spend.unrecorded).toBe(1);
  });

  it('reports nothing for a board with no runs', () => {
    expect(spentSince(handle.sqlite, BOARD, 0)).toEqual(NOTHING_SPENT);
  });

  it('counts from local midnight, not from midnight UTC', () => {
    const midnight = new Date(startOfDay(Date.now()));

    // A daily budget is a day in the operator's timezone. Counting in UTC
    // would reset the budget in the middle of an evening's work.
    expect(midnight.getHours()).toBe(0);
    expect(midnight.getMinutes()).toBe(0);
  });
});

describe('deciding whether it is spent', () => {
  it('is not over when there is no budget', () => {
    expect(overBudget({ tokens: 1_000_000, runs: 1, unrecorded: 0 }, null)).toBe(false);
  });

  it('is over at the budget, not only past it', () => {
    expect(overBudget({ tokens: 1_000, runs: 1, unrecorded: 0 }, 1_000)).toBe(true);
    expect(overBudget({ tokens: 999, runs: 1, unrecorded: 0 }, 1_000)).toBe(false);
  });
});

describe('describing it', () => {
  it('says the total is a lower bound when runs recorded nothing', () => {
    const note = describeSpend({ tokens: 18_000, runs: 8, unrecorded: 6 }, 20_000);

    // '18k of 20k' reads as a measurement. With six runs missing it is not one,
    // and presenting it as one misleads the operator into trusting it (R10).
    expect(note).toContain('at least');
    expect(note).toContain('6 of 8');
  });

  it('says nothing extra when every run was recorded', () => {
    expect(describeSpend({ tokens: 18_000, runs: 8, unrecorded: 0 }, 20_000)).toBe(
      '18k tokens of 20k today.',
    );
  });
});
