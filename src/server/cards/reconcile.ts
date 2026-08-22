import type { Database } from 'better-sqlite3';

import { clearLeases } from '../dispatch/lease.js';

/**
 * Cards left running when the board stopped (T47).
 *
 * Dispatch is in-process: the launcher's children belong to this server, and
 * shutdown cancels them. So a card found in `running` at startup is not
 * running - there is nothing supervising it and nothing that ever will. The
 * board has already been bitten by the softer version of this, a run that read
 * as in progress for twenty-five hours, and a status nobody will ever correct
 * is worse than the softer version because it never resolves.
 *
 * Runs are reconciled separately, at the same moment, by `reconcileOpenRuns`.
 * This is the card's side of the same fact.
 */

export interface InterruptedCard {
  readonly id: string;
  readonly title: string;
}

export interface CardReconcileResult {
  readonly interrupted: readonly InterruptedCard[];
  /**
   * In-flight claims released (T7).
   *
   * A lease found at startup was taken by a process that is gone. Leaving it
   * would make every card that was running during a restart permanently
   * undispatchable - the same shape of bug as the cards left marked running.
   */
  readonly leasesCleared: number;
}

/**
 * Moves interrupted cards to blocked.
 *
 * Blocked rather than idle, deliberately. The card has a worktree with
 * whatever the run managed to do in it, and putting it back in the queue would
 * start a second run on top of the first one's half-finished work. Blocked
 * says a person has to decide, which is the truth.
 *
 * Abandoned would be wrong for the opposite reason: nobody abandoned it.
 */
export function reconcileRunningCards(sqlite: Database, now: number): CardReconcileResult {
  const running = sqlite
    .prepare("SELECT id, title FROM cards WHERE status = 'running'")
    .all() as InterruptedCard[];

  const leasesCleared = clearLeases(sqlite);
  if (running.length === 0) return { interrupted: [], leasesCleared };

  const block = sqlite.prepare("UPDATE cards SET status = 'blocked', updated_at = ? WHERE id = ?");
  sqlite.transaction(() => {
    for (const card of running) block.run(now, card.id);
  })();

  return { interrupted: running, leasesCleared };
}

/**
 * What `serve` prints. Null when there was nothing to correct.
 *
 * Names the cards rather than counting them. A count tells the operator that
 * something was interrupted; the names tell them which branch to go and look
 * at, which is the next thing they will do anyway.
 */
export function describeCardReconcile(result: CardReconcileResult): string | null {
  if (result.interrupted.length === 0) return null;

  const names = result.interrupted.map((card) => card.title).join(', ');
  const count = result.interrupted.length;

  return `Moved ${String(count)} card(s) out of running: they were cut off when the board last stopped, and their work is still on their branches. ${names}.`;
}
