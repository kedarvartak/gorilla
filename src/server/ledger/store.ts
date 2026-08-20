import { randomUUID } from 'node:crypto';

import { and, asc, eq, isNull } from 'drizzle-orm';

import type { DatabaseHandle } from '../db/client.js';
import { parseNumbers, parseStrings } from '../json.js';
import { extractionCursors, ledgerEntries } from '../db/schema.js';
import type { LedgerEntry, OperatorStatus } from './entries.js';
import { mergeCandidates, type StoredEntry } from './dedupe.js';

/**
 * Persistence for ledger entries (doc 08).
 *
 * Mechanical entries are derived on demand and need no storage. Model entries
 * do: they were paid for, and recomputing them when a card is opened would
 * spend money answering a question already answered.
 *
 * Insertion goes through dedupe, so a statement that arrives twice folds into
 * the entry it repeats and a statement that reverses one supersedes rather than
 * replaces it.
 */

function toStored(row: typeof ledgerEntries.$inferSelect): StoredEntry {
  return {
    id: row.id,
    kind: row.kind,
    statement: row.statement,
    ...(row.detail === null ? {} : { detail: row.detail }),
    ...(row.alternative === null ? {} : { alternative: row.alternative }),
    filePaths: parseStrings(row.filePaths),
    sourceEventIds: parseNumbers(row.sourceEventIds),
    origin: row.origin,
    ...(row.confidence === null ? {} : { confidence: row.confidence / 100 }),
    ...(row.model === null ? {} : { model: row.model }),
    supersededBy: row.supersededBy,
    // Carried, not derived: without it nothing downstream can tell an entry the
    // operator has already judged from one still waiting to be read.
    operatorStatus: row.operatorStatus,
    promotedTo: row.promotedTo,
  };
}

export function storedEntriesFor(handle: DatabaseHandle, cardId: string): StoredEntry[] {
  return handle.db
    .select()
    .from(ledgerEntries)
    .where(eq(ledgerEntries.cardId, cardId))
    .orderBy(asc(ledgerEntries.createdAt))
    .all()
    .map(toStored);
}

export function entryTimesFor(handle: DatabaseHandle, cardId: string): Record<string, number> {
  const times: Record<string, number> = {};

  for (const row of handle.db
    .select({ id: ledgerEntries.id, createdAt: ledgerEntries.createdAt })
    .from(ledgerEntries)
    .where(eq(ledgerEntries.cardId, cardId))
    .all()) {
    times[row.id] = row.createdAt;
  }

  return times;
}

export interface RecordResult {
  readonly inserted: number;
  readonly duplicates: number;
  readonly supersessions: number;
}

/**
 * Records extracted entries against a card.
 *
 * One transaction, because a half-recorded batch would leave the dedupe pool
 * inconsistent with what the next window compares against.
 */
export function recordEntries(
  handle: DatabaseHandle,
  cardId: string,
  runId: string,
  candidates: readonly LedgerEntry[],
  now = Date.now(),
): RecordResult {
  if (candidates.length === 0) return { inserted: 0, duplicates: 0, supersessions: 0 };

  const existing = storedEntriesFor(handle, cardId);
  const merged = mergeCandidates(candidates, existing);

  handle.sqlite.transaction(() => {
    // Folded sources first: a duplicate raises the evidence behind the entry it
    // repeats rather than adding a line nobody needs to read.
    for (const [id, extra] of Object.entries(merged.foldedSources)) {
      const row = handle.db.select().from(ledgerEntries).where(eq(ledgerEntries.id, id)).get();
      if (row === undefined) continue;

      const combined = [...new Set([...parseNumbers(row.sourceEventIds), ...extra])];

      handle.db
        .update(ledgerEntries)
        .set({ sourceEventIds: JSON.stringify(combined) })
        .where(eq(ledgerEntries.id, id))
        .run();
    }

    for (const entry of merged.inserted) {
      const id = randomUUID();

      handle.db
        .insert(ledgerEntries)
        .values({
          id,
          cardId,
          runId,
          kind: entry.kind,
          statement: entry.statement,
          detail: entry.detail ?? null,
          alternative: entry.alternative ?? null,
          filePaths: JSON.stringify(entry.filePaths ?? []),
          sourceEventIds: JSON.stringify(entry.sourceEventIds),
          origin: entry.origin,
          // Stored as an integer percentage: SQLite has no decimal type worth
          // the trouble, and one percent is finer than the figure deserves.
          confidence: entry.confidence === undefined ? null : Math.round(entry.confidence * 100),
          model: entry.model ?? null,
          createdAt: now,
        })
        .run();

      // A reversal marks the entry it contradicts rather than removing it.
      const supersession = merged.supersessions.find(
        (decision) => decision.entry.statement === entry.statement,
      );

      if (supersession?.relatedId !== undefined) {
        handle.db
          .update(ledgerEntries)
          .set({ supersededBy: id })
          .where(eq(ledgerEntries.id, supersession.relatedId))
          .run();
      }
    }
  })();

  return {
    inserted: merged.inserted.length,
    duplicates: merged.duplicates.length,
    supersessions: merged.supersessions.length,
  };
}

export interface CursorState {
  readonly throughSeq: number;
  readonly tokensSpent: number;
  readonly lastOutcome: string | null;
  readonly lastNote: string | null;
}

export function cursorFor(handle: DatabaseHandle, runId: string): CursorState {
  const row = handle.db
    .select()
    .from(extractionCursors)
    .where(eq(extractionCursors.runId, runId))
    .get();

  return row === undefined
    ? { throughSeq: 0, tokensSpent: 0, lastOutcome: null, lastNote: null }
    : {
        throughSeq: row.throughSeq,
        tokensSpent: row.tokensSpent,
        lastOutcome: row.lastOutcome,
        lastNote: row.lastNote,
      };
}

/**
 * Moves the cursor, never backwards.
 *
 * The clamp is not defensive tidiness. Both figures are monotonic facts - the
 * furthest window already extracted, and the money already spent - and a write
 * computed from a stale read would rewind them, causing a window to be extracted
 * and paid for a second time. Two writers on one run is not the normal case, but
 * the cost of getting it wrong is a duplicate charge rather than a wrong pixel.
 */
export function advanceCursor(
  handle: DatabaseHandle,
  runId: string,
  update: { throughSeq: number; tokensSpent: number; outcome: string; note?: string | undefined },
  now = Date.now(),
): void {
  const current = cursorFor(handle, runId);
  const throughSeq = Math.max(current.throughSeq, update.throughSeq);
  const tokensSpent = Math.max(current.tokensSpent, update.tokensSpent);

  handle.db
    .insert(extractionCursors)
    .values({
      runId,
      throughSeq,
      tokensSpent,
      lastOutcome: update.outcome,
      lastNote: update.note ?? null,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: extractionCursors.runId,
      set: {
        throughSeq,
        tokensSpent,
        lastOutcome: update.outcome,
        lastNote: update.note ?? null,
        updatedAt: now,
      },
    })
    .run();
}

/** The operator's judgement, which the repair path in doc 12 draws only from. */
export function setOperatorStatus(
  handle: DatabaseHandle,
  entryId: string,
  status: OperatorStatus,
  statement?: string,
): void {
  handle.db
    .update(ledgerEntries)
    .set({
      operatorStatus: status,
      ...(statement === undefined ? {} : { statement }),
    })
    .where(eq(ledgerEntries.id, entryId))
    .run();
}

/** One stored entry by id, or undefined. Used to check a judgement can land. */
export function storedEntryById(handle: DatabaseHandle, entryId: string): StoredEntry | undefined {
  const row = handle.db.select().from(ledgerEntries).where(eq(ledgerEntries.id, entryId)).get();
  return row === undefined ? undefined : toStored(row);
}

/** Records that an entry became a rule, so it is not offered for promotion twice. */
export function markPromoted(handle: DatabaseHandle, entryId: string, rule: string): void {
  handle.db
    .update(ledgerEntries)
    .set({ promotedTo: rule })
    .where(eq(ledgerEntries.id, entryId))
    .run();
}

/**
 * Corrections the operator has made and the agent has not been told about.
 *
 * Undelivered rather than recent: a correction made three weeks ago that never
 * reached a run is still news to the agent, and one made an hour ago that was
 * already delivered is not.
 */
export function undeliveredCorrections(
  handle: DatabaseHandle,
  cardId: string,
): { id: string; statement: string }[] {
  return handle.db
    .select({ id: ledgerEntries.id, statement: ledgerEntries.statement })
    .from(ledgerEntries)
    .where(
      and(
        eq(ledgerEntries.cardId, cardId),
        eq(ledgerEntries.operatorStatus, 'corrected'),
        isNull(ledgerEntries.correctionDeliveredAt),
      ),
    )
    .orderBy(asc(ledgerEntries.createdAt))
    .all();
}

/** Marks corrections as said, so the next session start does not repeat them. */
export function markCorrectionsDelivered(
  handle: DatabaseHandle,
  entryIds: readonly string[],
  now = Date.now(),
): void {
  for (const id of entryIds) {
    handle.db
      .update(ledgerEntries)
      .set({ correctionDeliveredAt: now })
      .where(eq(ledgerEntries.id, id))
      .run();
  }
}
