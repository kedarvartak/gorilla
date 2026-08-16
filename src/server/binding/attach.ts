import { randomUUID } from 'node:crypto';

import { and, asc, eq, isNull } from 'drizzle-orm';

import { CardError, getCard } from '../api/cards.js';
import type { DatabaseHandle } from '../db/client.js';
import { boards, cards, columns, events, runs, type Card } from '../db/schema.js';

/**
 * Attached-mode binding (doc 05, doc 07 section 3).
 *
 * The secondary path, and the one that keeps the product honest. Launched mode
 * binds authoritatively because the board started the session. A session the
 * operator starts in their terminal has no such link - and if those produce
 * nothing, the tool has created exactly the blind spot it exists to remove.
 *
 * So an unclaimed session gets a provisional card. It can be claimed
 * explicitly, or merged into an existing card afterwards.
 */

export interface ClaimResult {
  readonly cardId: string;
  readonly runId: string;
  readonly created: boolean;
}

/** Cards the operator could reasonably claim, offered in the SessionStart reply. */
export function claimableCards(handle: DatabaseHandle, boardId: string): Card[] {
  return handle.db
    .select()
    .from(cards)
    .where(eq(cards.boardId, boardId))
    .orderBy(asc(cards.position))
    .all()
    .filter((card) => card.status !== 'done' && card.status !== 'abandoned');
}

/**
 * The context returned to a starting session.
 *
 * Written as instruction rather than decoration: the operator sees this in the
 * transcript, and its job is to make claiming a card the obvious next step.
 */
export function sessionStartContext(
  handle: DatabaseHandle,
  boardId: string,
  boardName: string,
  boundCard: Card | null,
): string {
  if (boundCard !== null) {
    return (
      `Gorilla board "${boardName}" is observing this directory, and this session is ` +
      `bound to card "${boundCard.title}". Work recorded here is attributed to that card.`
    );
  }

  const open = claimableCards(handle, boardId).slice(0, 8);
  const list =
    open.length === 0
      ? 'There are no open cards yet.'
      : `Open cards: ${open.map((card) => `${card.title} (${card.id.slice(0, 8)})`).join('; ')}.`;

  return (
    `Gorilla board "${boardName}" is observing this directory. No card is claimed for this ` +
    `session, so its events are being held against a provisional card. ` +
    `To bind it, run /gorilla:claim <card-id>. ${list}`
  );
}

/** Binds an existing run to a card. */
export function claim(handle: DatabaseHandle, sessionId: string, cardId: string): ClaimResult {
  const run = handle.db.select().from(runs).where(eq(runs.sessionId, sessionId)).get();
  if (run === undefined) throw new CardError(`No run for session ${sessionId}.`, 404, 'sessionId');

  const card = getCard(handle, cardId);
  if (card.boardId !== run.boardId) {
    throw new CardError('That card belongs to a different board.', 400, 'cardId');
  }

  handle.db.update(runs).set({ cardId: card.id }).where(eq(runs.id, run.id)).run();

  return { cardId: card.id, runId: run.id, created: false };
}

function titleFor(sessionId: string, hint: string | null): string {
  const cleaned = hint?.trim().replace(/\s+/g, ' ') ?? '';
  if (cleaned !== '') return cleaned.slice(0, 80);
  return `Unclaimed session ${sessionId.slice(0, 8)}`;
}

/**
 * Creates a provisional card for a run that nobody claimed.
 *
 * Titled from whatever the session revealed about itself - Claude Code's own
 * `ai-title`, or the first user prompt. A card called "Unclaimed session
 * 3f2a1b" is honest but useless, so it is the last resort rather than the
 * default.
 */
export function inferCard(handle: DatabaseHandle, runId: string, titleHint: string | null): Card {
  const run = handle.db.select().from(runs).where(eq(runs.id, runId)).get();
  if (run === undefined) throw new CardError(`No such run: ${runId}`, 404);

  if (run.cardId !== null) return getCard(handle, run.cardId);

  const intake = handle.db
    .select()
    .from(columns)
    .where(eq(columns.boardId, run.boardId))
    .orderBy(asc(columns.position))
    .get();

  if (intake === undefined) throw new CardError('The board has no columns.', 409);

  const id = randomUUID();
  const now = Date.now();

  handle.sqlite.transaction(() => {
    handle.db
      .insert(cards)
      .values({
        id,
        boardId: run.boardId,
        columnId: intake.id,
        title: titleFor(run.sessionId, titleHint),
        body: `Created automatically for session ${run.sessionId}, which was not claimed.`,
        position: now,
        status: 'running',
        createdAt: now,
        updatedAt: now,
      })
      .run();

    handle.db.update(runs).set({ cardId: id }).where(eq(runs.id, runId)).run();
  })();

  return getCard(handle, id);
}

/** Runs with no card, which is what "inferred but not yet reviewed" looks like. */
export function unattributedRuns(handle: DatabaseHandle, boardId: string): string[] {
  return handle.db
    .select({ id: runs.id })
    .from(runs)
    .where(and(eq(runs.boardId, boardId), isNull(runs.cardId)))
    .all()
    .map((row) => row.id);
}

export interface MergeResult {
  readonly targetCardId: string;
  readonly movedRuns: number;
  readonly movedEvents: number;
}

/**
 * Folds a provisional card into a real one.
 *
 * Its runs move across, so the events move with them. Losing them would defeat
 * the point of having inferred the card at all - the work happened, and it has
 * to remain attributable.
 */
export function mergeCard(
  handle: DatabaseHandle,
  sourceCardId: string,
  targetCardId: string,
): MergeResult {
  if (sourceCardId === targetCardId) {
    throw new CardError('A card cannot be merged into itself.', 400, 'targetCardId');
  }

  const source = getCard(handle, sourceCardId);
  const target = getCard(handle, targetCardId);

  if (source.boardId !== target.boardId) {
    throw new CardError('Those cards belong to different boards.', 400, 'targetCardId');
  }

  let movedRuns = 0;
  let movedEvents = 0;

  handle.sqlite.transaction(() => {
    const sourceRuns = handle.db.select().from(runs).where(eq(runs.cardId, sourceCardId)).all();

    for (const run of sourceRuns) {
      handle.db.update(runs).set({ cardId: targetCardId }).where(eq(runs.id, run.id)).run();
      movedRuns += 1;

      movedEvents += handle.db.select().from(events).where(eq(events.runId, run.id)).all().length;
    }

    handle.db.delete(cards).where(eq(cards.id, sourceCardId)).run();
  })();

  return { targetCardId, movedRuns, movedEvents };
}

/** Board for a working directory, used when a SessionStart arrives. */
export function boardForCwd(
  handle: DatabaseHandle,
  cwd: string,
): { id: string; name: string } | null {
  const board = handle.db.select().from(boards).where(eq(boards.cwd, cwd)).get();
  return board === undefined ? null : { id: board.id, name: board.name };
}
