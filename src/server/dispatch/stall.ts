import type Database from 'better-sqlite3';

/**
 * Detecting a run that has stopped getting anywhere (doc 18).
 *
 * Written after a real overnight failure: a dispatched card spent twenty-five
 * hours issuing the same blocked `npm install` once an hour, 63 times, while the
 * board reported it as `running` and the queue waited behind it. The agent was
 * not misbehaving - it was launched under a permission mode that could not run a
 * single command - but nothing was watching for the shape of that failure.
 *
 * `#effectOf` in the dispatcher already recognised the same condition, and only
 * looked for it once the run had *finished*. A run that never finishes never
 * reaches that check, which is exactly the case that costs a night.
 *
 * Two shapes, both read from events alone rather than from anything the agent
 * says about itself:
 *
 * - **A denial storm.** Tool calls are being attempted and none are completing.
 *   Under most permission modes a refused call leaves a `PreToolUse` with no
 *   outcome at all - no `PermissionDenied`, no `PostToolUseFailure` - so the gap
 *   between intents and outcomes is the only evidence there is.
 * - **Silence.** No event of any kind for long enough that the session is either
 *   wedged or waiting for a human who is asleep.
 *
 * Deliberately conservative. A false positive cancels work in progress, so both
 * thresholds are set well beyond anything a healthy run produces.
 */

export type StallKind = 'denial-storm' | 'silent';

export interface StallVerdict {
  readonly stalled: boolean;
  readonly kind?: StallKind;
  /** Operator-facing, and specific enough to act on without opening a timeline. */
  readonly detail?: string;
}

export interface StallThresholds {
  /** Unresolved tool intents before a run counts as stuck. */
  readonly maxUnresolved: number;
  /** Silence, in ms, before a run counts as wedged. */
  readonly maxSilenceMs: number;
  /** Grace period after launch: a starting session is legitimately quiet. */
  readonly graceMs: number;
}

export const DEFAULT_STALL: StallThresholds = {
  // Twelve refused calls in a row is not a rough patch, it is a wall. The failure
  // this exists to catch produced a hundred.
  maxUnresolved: 12,
  maxSilenceMs: 15 * 60 * 1000,
  graceMs: 90 * 1000,
};

export interface RunProgress {
  readonly intents: number;
  readonly outcomes: number;
  readonly lastEventAt: number | null;
  readonly startedAt: number;
}

export function progressOf(sqlite: Database.Database, runId: string): RunProgress | null {
  const run = sqlite.prepare('SELECT started_at FROM runs WHERE id = ?').get(runId) as
    { started_at: number } | undefined;

  if (run === undefined) return null;

  const row = sqlite
    .prepare(
      `SELECT
         SUM(CASE WHEN event_name = 'PreToolUse' THEN 1 ELSE 0 END) AS intents,
         SUM(CASE WHEN event_name IN ('PostToolUse', 'PostToolUseFailure') THEN 1 ELSE 0 END) AS outcomes,
         MAX(received_at) AS last
       FROM events WHERE run_id = ?`,
    )
    .get(runId) as { intents: number | null; outcomes: number | null; last: number | null };

  return {
    intents: row.intents ?? 0,
    outcomes: row.outcomes ?? 0,
    lastEventAt: row.last,
    startedAt: run.started_at,
  };
}

export function assessStall(
  progress: RunProgress,
  now: number,
  thresholds: StallThresholds = DEFAULT_STALL,
): StallVerdict {
  const age = now - progress.startedAt;

  // A session that has only just started has not had time to do anything, and
  // cancelling it would be the board's own impatience rather than a stall.
  if (age < thresholds.graceMs) return { stalled: false };

  const unresolved = progress.intents - progress.outcomes;

  if (unresolved >= thresholds.maxUnresolved && progress.outcomes === 0) {
    return {
      stalled: true,
      kind: 'denial-storm',
      detail:
        `${String(unresolved)} tool call(s) attempted and not one completed. ` +
        'That is what a permission wall looks like from the outside: the calls are ' +
        'refused before they run, so they leave an intent with no outcome. Check the ' +
        "card's permission mode before dispatching it again.",
    };
  }

  const since = now - (progress.lastEventAt ?? progress.startedAt);

  if (since >= thresholds.maxSilenceMs) {
    return {
      stalled: true,
      kind: 'silent',
      detail:
        `No event for ${String(Math.round(since / 60000))} minute(s). The session is ` +
        'either wedged or waiting for an answer from you.',
    };
  }

  return { stalled: false };
}
