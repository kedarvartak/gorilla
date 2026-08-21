import type { Database } from 'better-sqlite3';

/**
 * What a board has spent today (T27).
 *
 * The per-card ceiling stops one runaway run. It does nothing about a queue of
 * fifty reasonable cards, which is the shape an overnight batch actually takes:
 * nothing individually alarming, and a bill in the morning.
 *
 * Tokens rather than dollars, because tokens are the reading the board always
 * has. A price exists only for runs whose stream carried the CLI's own total,
 * so a budget denominated in money would be enforced against a figure that is
 * missing for some runs and present for others - and would quietly under-count
 * exactly when it mattered.
 */

export interface BoardSpend {
  readonly tokens: number;
  readonly runs: number;
  /**
   * Runs that recorded no usage at all, and so contribute nothing to the total.
   *
   * Reported rather than assumed away: the honest claim is "at least this
   * much", and an operator who does not know how many runs are missing cannot
   * tell a reliable total from a mostly-blank one.
   */
  readonly unrecorded: number;
}

export const NOTHING_SPENT: BoardSpend = { tokens: 0, runs: 0, unrecorded: 0 };

/** Local midnight, because a daily budget is a day in the operator's timezone. */
export function startOfDay(now: number): number {
  const date = new Date(now);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

export function spentSince(sqlite: Database, boardId: string, since: number): BoardSpend {
  const row = sqlite
    .prepare(
      `SELECT
         COALESCE(SUM(
           COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0)
           + COALESCE(cache_read_tokens, 0) + COALESCE(cache_creation_tokens, 0)
         ), 0) AS tokens,
         COUNT(*) AS runs,
         SUM(CASE WHEN cost_source IS NULL THEN 1 ELSE 0 END) AS unrecorded
       FROM runs
       WHERE board_id = ? AND started_at >= ?`,
    )
    .get(boardId, since) as { tokens: number; runs: number; unrecorded: number | null };

  return { tokens: row.tokens, runs: row.runs, unrecorded: row.unrecorded ?? 0 };
}

export function overBudget(spend: BoardSpend, budget: number | null): boolean {
  return budget !== null && budget > 0 && spend.tokens >= budget;
}

/**
 * One line for the operator, which has to carry the uncertainty with it.
 *
 * "18k of 20k spent" reads as a measurement. When six of today's runs recorded
 * nothing, it is a lower bound, and saying so is the difference between an
 * operator who trusts the number appropriately and one who is misled by it.
 */
export function describeSpend(spend: BoardSpend, budget: number | null): string {
  const spent = `${String(Math.round(spend.tokens / 1_000))}k tokens`;
  const of = budget === null ? '' : ` of ${String(Math.round(budget / 1_000))}k`;
  const caveat =
    spend.unrecorded === 0
      ? ''
      : ` (at least: ${String(spend.unrecorded)} of ${String(spend.runs)} runs recorded no usage)`;

  return `${spent}${of} today${caveat}.`;
}
