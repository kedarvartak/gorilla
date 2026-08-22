import type { Database } from 'better-sqlite3';

import { parseObject } from '../json.js';
import { redactPayload } from './redact.js';
import type { FixtureEntry } from './recorder.js';

/**
 * Turning a run that already happened into a fixture (T66).
 *
 * The recorder captures the hook stream while it arrives, which means a
 * fixture only exists if somebody thought to record before the interesting
 * thing happened. In practice the interesting thing is a dispatch bug found
 * afterwards, in a run nobody was recording, and the bug gets described in a
 * card instead of reproduced.
 *
 * Every event is already in the database. This reads one run back out in the
 * shape the replay command expects, so a run that misbehaved becomes an input
 * the suite can be pointed at.
 */

export interface FixtureFromRun {
  readonly entries: readonly FixtureEntry[];
  /** Events the run recorded, which is what a caller checks before writing a file. */
  readonly count: number;
}

export const EMPTY: FixtureFromRun = { entries: [], count: 0 };

export function fixtureFromRun(sqlite: Database, runId: string): FixtureFromRun {
  const rows = sqlite
    .prepare(
      'SELECT event_name AS event, received_at AS receivedAt, payload FROM events WHERE run_id = ? ORDER BY seq',
    )
    .all(runId) as { event: string; receivedAt: number; payload: string }[];

  const first = rows[0];
  if (first === undefined) return EMPTY;

  const entries = rows.map((row) => ({
    // Relative to the first event, as the recorder writes them, so replay
    // reproduces the original pacing rather than firing everything at once.
    t: row.receivedAt - first.receivedAt,
    event: row.event,
    // Through the same redactor the live recorder uses. A fixture made from a
    // real run carries whatever that run read, and a fixture is a file people
    // commit.
    payload: redactPayload(parseObject(row.payload)),
  }));

  return { entries, count: entries.length };
}

/** The file the replay command reads: one JSON object per line. */
export function renderFixture(fixture: FixtureFromRun): string {
  return fixture.entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n';
}
