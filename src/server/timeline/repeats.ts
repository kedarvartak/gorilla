import type { Database } from 'better-sqlite3';

import { parseObject, toolPath } from '../json.js';

/**
 * The same thing failing over and over (T33).
 *
 * A run that is refused a tool does not stop. It tries again, usually with the
 * same call, sometimes eighty times, and the timeline renders eighty rows that
 * each look like work. The stall detector already counts this in aggregate to
 * decide whether a run is getting anywhere; nothing has ever shown the
 * operator what was repeating.
 *
 * Grouped on the tool call that never answered, rather than on an error
 * string. Payloads carry no reliable error marker - the closest thing is prose
 * inside stdout - and matching prose would flag a card about error handling
 * for containing the word error. A tool asked for and never answered is a fact
 * the events actually support.
 */

export interface Repeat {
  readonly tool: string;
  /** The path or target, when the payload had one. Null when it did not. */
  readonly target: string | null;
  readonly count: number;
}

interface Row {
  readonly event_name: string;
  readonly tool_name: string | null;
  readonly tool_use_id: string | null;
  readonly payload: string;
}

/** Repeats worth showing. Two of anything is a retry; three is a pattern. */
export const MIN_REPEATS = 3;

/**
 * Tool calls that were asked for and never answered, grouped.
 *
 * Matched by `tool_use_id`, which is the only field pairing a request with its
 * outcome. Counting `PreToolUse` against `PostToolUse` in aggregate would
 * report an imbalance without saying which call it belonged to.
 */
export function repeatsIn(sqlite: Database, runId: string): Repeat[] {
  const rows = sqlite
    .prepare(
      `SELECT event_name, tool_name, tool_use_id, payload
       FROM events WHERE run_id = ? ORDER BY seq`,
    )
    .all(runId) as Row[];

  const answered = new Set(
    rows
      .filter((row) => row.event_name === 'PostToolUse' || row.event_name === 'PostToolUseFailure')
      .map((row) => row.tool_use_id)
      .filter((id): id is string => id !== null),
  );

  const counts = new Map<string, Repeat>();

  for (const row of rows) {
    if (row.event_name !== 'PreToolUse') continue;
    // A call with no id cannot be paired with an outcome, so it cannot be
    // shown to have gone unanswered. Skipped rather than guessed at.
    if (row.tool_use_id === null || answered.has(row.tool_use_id)) continue;

    const target = toolPath(parseObject(row.payload));
    const tool = row.tool_name ?? 'a tool';
    const key = `${tool} ${target ?? ''}`;
    const existing = counts.get(key);

    counts.set(key, { tool, target, count: (existing?.count ?? 0) + 1 });
  }

  return [...counts.values()]
    .filter((repeat) => repeat.count >= MIN_REPEATS)
    .sort((left, right) => right.count - left.count);
}

/**
 * One line, or nothing.
 *
 * Phrased as unanswered rather than as denied. A call goes unanswered when it
 * is refused, and also when the run was killed mid-call or the hook carrying
 * its outcome never arrived, and the board cannot tell those apart from here.
 */
export function describeRepeats(repeats: readonly Repeat[]): string | null {
  if (repeats.length === 0) return null;

  const worst = repeats[0];
  if (worst === undefined) return null;

  const what = worst.target === null ? worst.tool : `${worst.tool} on ${worst.target}`;
  const others = repeats.length - 1;
  const more = others === 0 ? '' : `, along with ${String(others)} other repeated call(s)`;

  return `${what} was asked for ${String(worst.count)} times and never answered${more}. Usually a denied permission the run kept retrying.`;
}
