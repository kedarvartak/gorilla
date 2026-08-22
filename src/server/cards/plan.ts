import type { Db } from '../db/client.js';
import { executionOrder } from './order.js';
import { blockersFor } from './eligibility.js';
import { cards } from '../db/schema.js';
import { eq } from 'drizzle-orm';

/**
 * The order the board will work in, and what each card is waiting for (T64).
 *
 * The backlog asked for a dependency graph. Drawn edges would answer "what
 * depends on what" and not the question an operator actually has, which is
 * "why has nothing started". Rank already exists and the board already shows
 * it; what was missing is the reason beside it.
 *
 * A layered list rather than a picture, because that is what this interface
 * is, and because a graph of forty cards is a picture nobody can read anyway.
 */

export interface PlannedCard {
  readonly cardId: string;
  readonly title: string;
  readonly rank: number;
  readonly status: string;
  readonly blocked: boolean;
  /** The cards it waits for, by title. Empty when it is free to run. */
  readonly waitingFor: readonly string[];
}

export interface Plan {
  readonly cards: readonly PlannedCard[];
  /** Cards free to run right now. The number the operator is really asking for. */
  readonly free: number;
}

export function buildPlan(db: Db, boardId: string): Plan {
  const ranked = executionOrder(db, boardId);

  const titles = new Map(
    db
      .select({ id: cards.id, title: cards.title, status: cards.status })
      .from(cards)
      .where(eq(cards.boardId, boardId))
      .all()
      .map((card) => [card.id, card]),
  );

  const planned = ranked.map((entry) => {
    const card = titles.get(entry.cardId);

    return {
      cardId: entry.cardId,
      title: card?.title ?? entry.cardId,
      rank: entry.rank,
      status: card?.status ?? 'unknown',
      blocked: entry.blocked,
      // Titles rather than ids. "Waiting for 4f2a1b9c" is a lookup; "waiting
      // for the schema migration" is an answer.
      waitingFor: blockersFor(db, entry.cardId).map((blocker) => blocker.title),
    };
  });

  return { cards: planned, free: planned.filter((card) => !card.blocked).length };
}

/**
 * One line for the operator.
 *
 * There is deliberately no "nothing can start" case. Dependencies are refused
 * at creation if they would cycle, and a finite acyclic graph always has a
 * source - so a board with cards remaining always has at least one free. A
 * message for that state would be one nobody can ever reach, which is worse
 * than absent: it would sit in the code looking like a handled case.
 */
export function describePlan(plan: Plan): string {
  if (plan.cards.length === 0) return 'Nothing is left to do on this board.';

  const waiting = plan.cards.length - plan.free;

  return waiting === 0
    ? `${String(plan.cards.length)} card(s) left, none waiting on another.`
    : `${String(plan.free)} of ${String(plan.cards.length)} card(s) can start now; ${String(waiting)} are waiting on another card.`;
}
