import type { Database } from 'better-sqlite3';

/**
 * When each card last did anything (doc 18, U6).
 *
 * The digest claims to answer "what happened while I was asleep". It does not
 * currently: a card that has been blocked for three days appears in exactly the
 * same way as one that failed an hour ago, so the list only ever grows and the
 * claim at the top of the screen becomes false. An operator who reads a
 * standing backlog every morning learns to skim the one screen written to be
 * read carefully, which is the volume problem this product exists to remove.
 *
 * Separating the two needs one fact the digest never had: when each card last
 * moved. Everything else is arithmetic on it.
 */

export interface CardActivity {
  /** The last hook event on any run of this card. Null when it never ran. */
  readonly lastActivityAt: number | null;
}

interface ActivityRow {
  card_id: string;
  last_at: number;
}

export function lastActivityByCard(sqlite: Database, boardId: string): Map<string, number> {
  const rows = sqlite
    .prepare(
      `SELECT runs.card_id AS card_id, MAX(events.received_at) AS last_at
         FROM runs
         JOIN events ON events.run_id = runs.id
        WHERE runs.board_id = ? AND runs.card_id IS NOT NULL
        GROUP BY runs.card_id`,
    )
    .all(boardId) as ActivityRow[];

  return new Map(rows.map((row) => [row.card_id, row.last_at]));
}

/**
 * How long a night is, when nobody says.
 *
 * Sixteen hours rather than twenty-four: the operator who left at six in the
 * evening and reads this at eight in the morning should see the evening's work
 * as news. A full day would fold yesterday morning into "while you were away",
 * which is the same conflation from the other direction.
 */
export const DEFAULT_WINDOW_MS = 16 * 60 * 60 * 1_000;

export type Recency = 'moved' | 'waiting' | 'never-ran';

export interface RecencyVerdict {
  readonly recency: Recency;
  readonly lastActivityAt: number | null;
  /** How long it has been sitting, for the cards that are merely sitting. */
  readonly waitingForMs: number | null;
}

export function classify(
  lastActivityAt: number | null,
  cutoff: number,
  now: number,
): RecencyVerdict {
  if (lastActivityAt === null) {
    // Distinct from waiting. A card that has never run is waiting on the
    // operator to dispatch it; a card that ran and stopped is waiting on the
    // operator to read it. Those need different actions.
    return { recency: 'never-ran', lastActivityAt: null, waitingForMs: null };
  }

  if (lastActivityAt >= cutoff) {
    return { recency: 'moved', lastActivityAt, waitingForMs: null };
  }

  return { recency: 'waiting', lastActivityAt, waitingForMs: Math.max(0, now - lastActivityAt) };
}

/** "3 days", "5 hours" - said plainly, because the number is the point. */
export function describeWait(waitingForMs: number): string {
  const hours = Math.floor(waitingForMs / 3_600_000);
  if (hours < 1) return 'under an hour';
  if (hours < 48) return `${String(hours)} hour${hours === 1 ? '' : 's'}`;

  const days = Math.floor(hours / 24);
  return `${String(days)} days`;
}
