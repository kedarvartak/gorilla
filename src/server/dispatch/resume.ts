import type { Database } from 'better-sqlite3';

import { INTERRUPTED } from '../ingest/lifecycle.js';

/**
 * Picking up a run that was cut off rather than starting it again (T46).
 *
 * The launcher has been able to pass `--resume` since it was written, and
 * nothing has ever set it. So a card interrupted by a restart began from
 * nothing on its next attempt: the worktree survived, and the reasoning that
 * produced it did not.
 *
 * Claude Code already stores the session. This is not a second checkpoint
 * store, it is the board finally using the one that exists.
 */

export interface Resumable {
  readonly sessionId: string;
  readonly runId: string;
  /** Why the board thinks this is worth resuming, for the record. */
  readonly why: string;
}

/**
 * The session to resume, or null.
 *
 * Deliberately narrow. Only a run the board itself recorded as interrupted -
 * cut off mid-flight, with no `SessionEnd` - is a candidate. A run that failed
 * on its own terms finished; resuming it would drop the agent back into the
 * turn where it had already decided it could not proceed, and it would decide
 * that again at a cost.
 */
export function resumableFor(sqlite: Database, cardId: string): Resumable | null {
  const row = sqlite
    .prepare(
      `SELECT id AS runId, session_id AS sessionId
       FROM runs
       WHERE card_id = ? AND end_reason = ?
       ORDER BY started_at DESC
       LIMIT 1`,
    )
    .get(cardId, INTERRUPTED) as { runId: string; sessionId: string } | undefined;

  if (row === undefined) return null;

  // A later run means the card has been dispatched since the interruption and
  // whatever the interrupted session knew has already been superseded.
  const newer = sqlite
    .prepare(
      `SELECT COUNT(*) AS n FROM runs
       WHERE card_id = ? AND started_at > (SELECT started_at FROM runs WHERE id = ?)`,
    )
    .get(cardId, row.runId) as { n: number };

  if (newer.n > 0) return null;

  return {
    sessionId: row.sessionId,
    runId: row.runId,
    why: 'the last run was cut off rather than finishing, so its session is worth continuing',
  };
}

/** One line for the operator, because a resumed run is not a fresh one. */
export function describeResume(resumable: Resumable | null): string {
  return resumable === null
    ? 'Starting a new session.'
    : `Resuming session ${resumable.sessionId.slice(0, 8)}: ${resumable.why}.`;
}
