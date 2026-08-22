import type { Database } from 'better-sqlite3';

/**
 * Whether the board is getting anywhere (T59, T60).
 *
 * Every fact needed to answer that has been recorded for months and nothing
 * has ever read it back. The operator's real questions are how much work goes
 * through in a week, how long a card sits before anyone looks at it, and what
 * actually breaks - and the third one is the one memory gets most wrong, since
 * the failure that is remembered is the annoying one rather than the common
 * one.
 */

export interface Throughput {
  readonly created: number;
  readonly merged: number;
  /**
   * Median rather than mean, and null rather than zero when nothing merged.
   *
   * One card that sat for three weeks moves a mean enough to make a good week
   * look bad, and a mean over two cards is not a measurement of anything.
   */
  readonly medianLeadTimeMs: number | null;
  readonly sampled: number;
}

export interface FailureCount {
  readonly reason: string;
  readonly cards: number;
}

export interface Metrics {
  readonly since: number;
  readonly throughput: Throughput;
  /** Most common first, because the point is which failure to fix. */
  readonly failures: readonly FailureCount[];
  /** Cards that have never run, and are therefore in nobody's throughput. */
  readonly neverRan: number;
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;

  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);

  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    : (sorted[middle] ?? null);
}

/**
 * Lead time is creation to merge, not dispatch to merge.
 *
 * The operator's question is how long the work took from being asked for, and
 * a measure that starts at dispatch would report a board that never got round
 * to a card as fast.
 */
export function readMetrics(sqlite: Database, boardId: string, since: number): Metrics {
  const created = (
    sqlite
      .prepare('SELECT COUNT(*) AS n FROM cards WHERE board_id = ? AND created_at >= ?')
      .get(boardId, since) as { n: number }
  ).n;

  const merged = sqlite
    .prepare(
      'SELECT created_at AS createdAt, merged_at AS mergedAt FROM cards WHERE board_id = ? AND merged_at IS NOT NULL AND merged_at >= ?',
    )
    .all(boardId, since) as { createdAt: number; mergedAt: number }[];

  const failures = sqlite
    .prepare(
      `SELECT end_reason AS reason, COUNT(DISTINCT card_id) AS cards
       FROM runs
       WHERE board_id = ? AND started_at >= ? AND end_reason IS NOT NULL AND card_id IS NOT NULL
       GROUP BY end_reason
       ORDER BY cards DESC, reason`,
    )
    .all(boardId, since) as { reason: string; cards: number }[];

  const neverRan = (
    sqlite
      .prepare(
        `SELECT COUNT(*) AS n FROM cards
         WHERE board_id = ? AND id NOT IN (SELECT card_id FROM runs WHERE card_id IS NOT NULL)`,
      )
      .get(boardId) as { n: number }
  ).n;

  return {
    since,
    throughput: {
      created,
      merged: merged.length,
      medianLeadTimeMs: median(merged.map((card) => card.mergedAt - card.createdAt)),
      sampled: merged.length,
    },
    failures,
    // Counted separately rather than folded into throughput. A board with
    // forty cards nobody has started is not a slow board, it is a full one,
    // and the two call for different responses.
    neverRan,
  };
}

function days(ms: number): string {
  const hours = ms / 3_600_000;
  if (hours < 1) return 'under an hour';
  if (hours < 48) return `${String(Math.round(hours))} hours`;
  return `${String(Math.round(hours / 24))} days`;
}

export function describeMetrics(metrics: Metrics): string[] {
  const lines = [
    `${String(metrics.throughput.merged)} merged, ${String(metrics.throughput.created)} added.`,
  ];

  if (metrics.throughput.medianLeadTimeMs === null) {
    // Not "0 days". Nothing merged, which is a different fact and the more
    // interesting one.
    lines.push('Nothing has merged in this window, so there is no lead time to report.');
  } else {
    lines.push(
      `Median time from a card being written to it merging: ${days(metrics.throughput.medianLeadTimeMs)}, over ${String(metrics.throughput.sampled)} card(s).`,
    );
  }

  const worst = metrics.failures[0];
  if (worst !== undefined) {
    lines.push(
      `Most common ending: ${worst.reason}, on ${String(worst.cards)} card(s). The failure people remember is the annoying one, not the common one.`,
    );
  }

  if (metrics.neverRan > 0) {
    lines.push(`${String(metrics.neverRan)} card(s) have never run at all.`);
  }

  return lines;
}
