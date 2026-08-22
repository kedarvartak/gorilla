import type { Database } from 'better-sqlite3';

/**
 * The claim a dispatcher holds on a card while it runs it (T7).
 *
 * The in-memory guard this replaces was per-process and sat after the worktree
 * was created. Two servers on one database, or one server racing itself
 * between creating the checkout and launching into it, could both get past it
 * and put two agents in one worktree - where they overwrite each other and the
 * damage is not discovered until merge time.
 *
 * A primary key makes that impossible without any coordination: the insert
 * either succeeds or it does not, and SQLite decides which.
 */

export interface Lease {
  readonly cardId: string;
  readonly acquiredAt: number;
  readonly owner: string;
}

/**
 * Identifies this process. Deliberately not stable across restarts: a lease
 * that survived the process holding it is a lease on a run that no longer
 * exists, and startup needs to be able to tell one of those from a live one.
 */
export function ownerId(): string {
  return `pid-${String(process.pid)}-${String(process.hrtime.bigint())}`;
}

/**
 * Returns false rather than throwing when the card is already claimed.
 *
 * A refused dispatch is an ordinary outcome here - the queue asks for cards it
 * may already be running - and an exception would make the common case the
 * expensive one.
 */
export function acquireLease(
  sqlite: Database,
  cardId: string,
  owner: string,
  now: number,
): boolean {
  const result = sqlite
    .prepare('INSERT OR IGNORE INTO card_leases (card_id, acquired_at, owner) VALUES (?, ?, ?)')
    .run(cardId, now, owner);

  return result.changes === 1;
}

export function releaseLease(sqlite: Database, cardId: string): void {
  sqlite.prepare('DELETE FROM card_leases WHERE card_id = ?').run(cardId);
}

export function leaseFor(sqlite: Database, cardId: string): Lease | null {
  const row = sqlite
    .prepare(
      'SELECT card_id AS cardId, acquired_at AS acquiredAt, owner FROM card_leases WHERE card_id = ?',
    )
    .get(cardId) as Lease | undefined;

  return row ?? null;
}

/**
 * Clears every lease at startup.
 *
 * Dispatch is in-process: a lease found at startup was taken by a process that
 * is gone, and nothing is running under it. Leaving them would make every card
 * that was in flight during a restart permanently undispatchable - the same
 * shape of bug as the cards left marked running, and the same fix.
 */
export function clearLeases(sqlite: Database): number {
  return sqlite.prepare('DELETE FROM card_leases').run().changes;
}
