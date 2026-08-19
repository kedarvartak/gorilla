import type Database from 'better-sqlite3';

import { readString } from '../json.js';

/**
 * Closing a run (doc 05).
 *
 * `SessionEnd` was registered as a hook and stored as an event, and nothing ever
 * wrote `runs.ended_at`. So every run the board had ever recorded read "in
 * progress" forever, and the interface asserted a live session for one that had
 * exited a day earlier. That is precisely the stale-signal failure this product
 * exists to remove, so it is worth more care than a one-line update.
 *
 * Two paths reach here. The event path is exact: `SessionEnd` arrived, so the
 * session is over and we know when. The reconciliation path is a deduction: the
 * board has just started, so it cannot be supervising anything, and any run
 * still open was cut off - by a board restart, a crash, or a killed terminal.
 *
 * The two are recorded with different reasons on purpose. "The session said it
 * ended" and "we inferred it must have" are different claims, and collapsing
 * them would put a guess and a fact behind the same word.
 */

/** Set when the board deduced the end rather than being told about it. */
export const INTERRUPTED = 'interrupted';

export interface RunLifecycleResult {
  readonly closed: boolean;
  readonly reopened: boolean;
}

/**
 * Applies one event's effect on its run's open/closed state.
 *
 * Called after the event is written, off the response path's critical work but
 * still synchronous, because it is a single indexed update and the interface
 * showing a run as live one moment longer than it was is the bug being fixed.
 */
export function applyRunLifecycle(
  sqlite: Database.Database,
  input: { runId: string; eventName: string; receivedAt: number; payload: unknown },
): RunLifecycleResult {
  if (input.eventName === 'SessionEnd') {
    sqlite
      .prepare('UPDATE runs SET ended_at = ?, end_reason = ? WHERE id = ?')
      .run(input.receivedAt, readString(input.payload, 'reason') ?? 'session ended', input.runId);

    return { closed: true, reopened: false };
  }

  // An event arriving on a run we had only *guessed* was over means the guess
  // was wrong - an attached terminal session outlived the board restart. Reopen
  // it. A run closed by a real SessionEnd is never reopened: a late-delivered
  // event after a genuine end is out-of-order delivery, which doc 06 says to
  // expect, not evidence of life.
  const changed = sqlite
    .prepare('UPDATE runs SET ended_at = NULL, end_reason = NULL WHERE id = ? AND end_reason = ?')
    .run(input.runId, INTERRUPTED).changes;

  return { closed: false, reopened: changed > 0 };
}

export interface ReconcileResult {
  /** Runs closed from a SessionEnd event that was received but never applied. */
  readonly backfilled: number;
  /** Runs closed by deduction, because the board cannot be supervising them. */
  readonly interrupted: number;
}

/**
 * Closes runs left open, at startup.
 *
 * The end time is the last event the run produced, not now. Claiming a run
 * lasted from yesterday evening until this morning's restart would be a
 * fabricated duration, and a made-up number is worse than an approximate one
 * because nothing marks it as made up.
 */
export function reconcileOpenRuns(sqlite: Database.Database): ReconcileResult {
  const open = sqlite.prepare('SELECT id FROM runs WHERE ended_at IS NULL').all() as {
    id: string;
  }[];

  let backfilled = 0;
  let interrupted = 0;

  const close = sqlite.prepare('UPDATE runs SET ended_at = ?, end_reason = ? WHERE id = ?');
  const lastEnd = sqlite.prepare(
    "SELECT received_at, payload FROM events WHERE run_id = ? AND event_name = 'SessionEnd' ORDER BY seq DESC LIMIT 1",
  );
  const lastAny = sqlite.prepare(
    'SELECT received_at FROM events WHERE run_id = ? ORDER BY seq DESC LIMIT 1',
  );

  sqlite.transaction(() => {
    for (const run of open) {
      const ended = lastEnd.get(run.id) as { received_at: number; payload: string } | undefined;

      if (ended !== undefined) {
        let reason = 'session ended';
        try {
          reason = readString(JSON.parse(ended.payload), 'reason') ?? reason;
        } catch {
          /* an unparseable payload is still evidence the session ended */
        }
        close.run(ended.received_at, reason, run.id);
        backfilled += 1;
        continue;
      }

      const last = lastAny.get(run.id) as { received_at: number } | undefined;
      // A run with no events at all is a binding that never produced anything;
      // its start is the only timestamp there is.
      const at =
        last?.received_at ??
        (
          sqlite.prepare('SELECT started_at FROM runs WHERE id = ?').get(run.id) as {
            started_at: number;
          }
        ).started_at;

      close.run(at, INTERRUPTED, run.id);
      interrupted += 1;
    }
  })();

  return { backfilled, interrupted };
}

export function describeReconcile(result: ReconcileResult): string | null {
  if (result.backfilled === 0 && result.interrupted === 0) return null;

  const parts: string[] = [];
  if (result.backfilled > 0) parts.push(`${String(result.backfilled)} had already ended`);
  if (result.interrupted > 0) parts.push(`${String(result.interrupted)} were cut off`);

  return `Closed ${String(result.backfilled + result.interrupted)} run(s) left open: ${parts.join(', ')}.`;
}
