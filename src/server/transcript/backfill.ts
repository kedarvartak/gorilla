import { randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';

import type { DatabaseHandle } from '../db/client.js';
import { events, runs } from '../db/schema.js';
import { findTranscripts } from './locate.js';
import { readTranscript } from './reader.js';

/**
 * Reconstructing runs from transcripts (doc 06, backfill).
 *
 * Promised since the architecture was written and never built, which made the
 * first impression of the product a blank screen. Installing a comprehension
 * tool on a project you have been working in for weeks and being shown nothing
 * you have done is the worst possible opening: the tool's whole claim is that it
 * remembers, and it starts by demonstrating that it does not.
 *
 * A transcript is not an event stream, so this cannot invent one. What it can
 * recover is real and limited: that a session existed, when it ran, which
 * directory and branch it was in, how much it said, and what model answered.
 * Everything the ledger needs beyond that came from hooks that were never
 * configured at the time, and no amount of reading makes it appear.
 *
 * So a backfilled run is marked as such rather than dressed up as a live one.
 * A history that quietly claims more fidelity than it has is worse than an
 * empty board, because the empty board at least tells the truth.
 */

/** The end reason written on a run the board reconstructed rather than watched. */
export const BACKFILLED = 'backfilled';

export interface BackfillResult {
  readonly runsAdded: number;
  readonly transcriptsSeen: number;
  readonly alreadyKnown: number;
  /** Files that could not be read, named rather than counted. */
  readonly unreadable: readonly string[];
}

export interface BackfillInput {
  readonly handle: DatabaseHandle;
  readonly boardId: string;
  readonly cwd: string;
  readonly home?: string;
  /** Bounded so one enormous transcript cannot stall the whole pass. */
  readonly maxBytes?: number;
}

/** Transcripts above this are summarised from their first records only. */
export const DEFAULT_MAX_BYTES = 40 * 1024 * 1024;

export async function backfillFromTranscripts(input: BackfillInput): Promise<BackfillResult> {
  const found = findTranscripts(input.cwd, input.home);

  const known = new Set(
    input.handle.db
      .select({ sessionId: runs.sessionId })
      .from(runs)
      .all()
      .map((row) => row.sessionId),
  );

  let runsAdded = 0;
  let alreadyKnown = 0;
  const unreadable: string[] = [];

  for (const transcript of found) {
    // A session the board already has is left entirely alone. Re-reading it
    // could only produce a worse version of what the hooks recorded live.
    if (known.has(transcript.sessionId)) {
      alreadyKnown += 1;
      continue;
    }

    try {
      if (statSync(transcript.path).size > (input.maxBytes ?? DEFAULT_MAX_BYTES)) {
        unreadable.push(`${transcript.path} (too large to read)`);
        continue;
      }
    } catch {
      unreadable.push(transcript.path);
      continue;
    }

    let summary;
    try {
      summary = await readTranscript(transcript.path);
    } catch {
      unreadable.push(transcript.path);
      continue;
    }

    if (!summary.exists || summary.recordCount === 0) continue;

    const runId = randomUUID();
    const startedAt = transcript.modifiedAt;

    input.handle.db
      .insert(runs)
      .values({
        id: runId,
        boardId: input.boardId,
        // Deliberately unbound. Attributing reconstructed history to a card
        // would be the board inventing a link nobody drew, and doc 05 already
        // says an unbound run is a legitimate state rather than a broken one.
        cardId: null,
        sessionId: transcript.sessionId,
        mode: 'attached',
        startedAt,
        // Closed on arrival: a run recovered from a file is not in progress, and
        // a reconstructed history that reads as live is the stale signal the
        // board exists to remove.
        endedAt: startedAt,
        endReason: BACKFILLED,
        model: summary.model,
        transcriptPath: transcript.path,
        cwd: summary.cwd ?? input.cwd,
        gitBranch: summary.gitBranch,
        lastSeq: 1,
      })
      .run();

    // One event, and it says what it is. Fabricating PreToolUse and PostToolUse
    // pairs from assistant prose would produce a timeline that looks recorded
    // and is guessed, and everything downstream treats events as evidence.
    input.handle.db
      .insert(events)
      .values({
        runId,
        sessionId: transcript.sessionId,
        seq: 1,
        eventName: 'SessionEnd',
        receivedAt: startedAt,
        payload: JSON.stringify({
          session_id: transcript.sessionId,
          cwd: summary.cwd ?? input.cwd,
          reason: BACKFILLED,
          _gorilla_backfill: {
            records: summary.recordCount,
            assistantMessages: summary.assistantCount,
            userMessages: summary.userCount,
            outputTokens: summary.totalOutputTokens,
            note:
              'Reconstructed from the transcript after the fact. The board was not ' +
              'running at the time, so no tool events exist for this session.',
          },
        }),
      })
      .run();

    runsAdded += 1;
  }

  return { runsAdded, transcriptsSeen: found.length, alreadyKnown, unreadable };
}

export function describeBackfill(result: BackfillResult): string[] {
  if (result.transcriptsSeen === 0) {
    return ['No transcripts found for this directory. Nothing to recover.'];
  }

  const lines = [
    `${String(result.transcriptsSeen)} transcript(s) found: ` +
      `${String(result.runsAdded)} recovered, ${String(result.alreadyKnown)} already known.`,
  ];

  if (result.runsAdded > 0) {
    // Said every time, because the limitation is the point. These runs carry
    // when and how much, and nothing about what was decided.
    lines.push(
      'Recovered runs have no tool events: the board was not running when they happened,',
      'so they record that a session existed and little more.',
    );
  }

  for (const path of result.unreadable) lines.push(`  could not read: ${path}`);

  return lines;
}
