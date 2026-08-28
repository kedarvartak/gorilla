import { and, eq, inArray, sql, isNull } from 'drizzle-orm';

import type { Db } from '../db/client.js';
import { cardDependencies, cards, columns } from '../db/schema.js';

/**
 * Which cards may move, and which may be dispatched (doc 05).
 *
 * Kept as queries rather than in-memory filtering so the dispatcher can answer
 * "what is eligible" without loading every card, and so the rule has exactly
 * one implementation that both the API and the dispatcher use.
 */

/** Statuses that mean a dependency has been satisfied. */
const SATISFIED = ['done'] as const;

export interface Blocker {
  readonly cardId: string;
  readonly title: string;
  readonly status: string;
}

/** Dependencies of `cardId` that are not yet done. */
export function blockersFor(db: Db, cardId: string): Blocker[] {
  const dependencyRows = db
    .select({ dependsOn: cardDependencies.dependsOnCardId })
    .from(cardDependencies)
    .where(eq(cardDependencies.cardId, cardId))
    .all();

  if (dependencyRows.length === 0) return [];

  const rows = db
    .select({ id: cards.id, title: cards.title, status: cards.status })
    .from(cards)
    .where(
      inArray(
        cards.id,
        dependencyRows.map((row) => row.dependsOn),
      ),
    )
    .all();

  return rows
    .filter((row) => !SATISFIED.includes(row.status as (typeof SATISFIED)[number]))
    .map((row) => ({ cardId: row.id, title: row.title, status: row.status }));
}

export interface MoveDecision {
  readonly allowed: boolean;
  readonly reason: string | null;
  readonly blockers: readonly Blocker[];
}

/**
 * Whether a card may enter a column.
 *
 * The rule Phase 1 enforces: a card cannot reach the terminal column while a
 * dependency is unfinished. Refusing is better than allowing, because a card
 * marked done whose prerequisite never completed is a false completion - doc
 * 01's fourth failure mode.
 */
export function canMoveTo(db: Db, cardId: string, columnId: string): MoveDecision {
  const column = db.select().from(columns).where(eq(columns.id, columnId)).get();

  if (column === undefined) {
    return { allowed: false, reason: `No such column: ${columnId}`, blockers: [] };
  }

  if (!column.isTerminal) return { allowed: true, reason: null, blockers: [] };

  const blockers = blockersFor(db, cardId);
  if (blockers.length === 0) return { allowed: true, reason: null, blockers: [] };

  return {
    allowed: false,
    reason:
      `Cannot complete this card while ${blockers.length} dependenc(ies) are unfinished: ` +
      blockers.map((blocker) => `${blocker.title} (${blocker.status})`).join(', '),
    blockers,
  };
}

/**
 * Ordering rank for a card's priority. SQL rather than JavaScript so the sort
 * happens in the same query as the filter and "the next card" has one
 * definition.
 */
const PRIORITY_RANK = sql`CASE ${cards.priority} WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END`;

/**
 * Cards eligible for dispatch: in a Ready column, idle, and unblocked.
 *
 * Ordered by column, then priority, then card position - so "the next one" is
 * well-defined, and a card marked high priority genuinely runs before its
 * neighbours. Priority that did not reorder the queue would be a label the
 * operator trusted and the system ignored (R10).
 *
 * A card with no goal condition is excluded, because dispatching one cannot
 * succeed: `dispatch` refuses it and halts the queue with `no-goal`. Reporting
 * it as dispatchable meant the interface offered a run button that could only
 * stop the queue, and under automatic mode a single title-only card would poison
 * the whole batch.
 */
export function dispatchableCards(db: Db, boardId: string): { id: string; title: string }[] {
  const ready = db
    .select({ id: cards.id, title: cards.title })
    .from(cards)
    .innerJoin(columns, eq(cards.columnId, columns.id))
    .where(
      and(
        eq(cards.boardId, boardId),
        eq(columns.isReady, true),
        eq(cards.status, 'idle'),
        // An archived card is one the operator put away. Dispatching it would
        // be the board reaching into a drawer they closed (T77).
        isNull(cards.archivedAt),
        sql`trim(coalesce(${cards.goalCondition}, '')) <> ''`,
      ),
    )
    .orderBy(columns.position, PRIORITY_RANK, cards.position)
    .all();

  return ready.filter((card) => blockersFor(db, card.id).length === 0);
}

/**
 * Detects whether adding an edge would create a cycle. A dependency cycle would
 * make every card in it permanently undispatchable, with no error to explain
 * why, so it is refused at write time.
 */
export function wouldCycle(db: Db, cardId: string, dependsOnCardId: string): boolean {
  if (cardId === dependsOnCardId) return true;

  const seen = new Set<string>();
  const stack = [dependsOnCardId];

  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined || seen.has(current)) continue;
    seen.add(current);

    if (current === cardId) return true;

    const next = db
      .select({ dependsOn: cardDependencies.dependsOnCardId })
      .from(cardDependencies)
      .where(eq(cardDependencies.cardId, current))
      .all();

    for (const row of next) stack.push(row.dependsOn);
  }

  return false;
}

/**
 * Why a card cannot be dispatched, or null when it can.
 *
 * `dispatchableCards` answers "which cards may run" and the interface used it
 * to decide whether to draw a run button. That made four separate rules -
 * ready column, idle, unarchived, goal condition, unblocked - share a single
 * invisible outcome: the button was simply absent, which reads as the button
 * having been removed rather than as the card being ineligible. It was
 * reported as exactly that.
 *
 * So the same predicates answer the other half of the question. Deliberately
 * built from the same rows as `dispatchableCards` rather than from a second
 * description of the rule: a reason that disagreed with the rule would be
 * worse than no reason, because the operator would act on it.
 */
export interface DispatchStanding {
  readonly id: string;
  /** Null when the card is dispatchable. */
  readonly reason: string | null;
  /**
   * Whether to draw a dispatch control at all.
   *
   * False in a terminal column. Restoring the button everywhere put a greyed
   * Run on twenty-four finished cards, which is not an explanation of
   * anything - nobody expects to dispatch a card in Done, so there is no
   * absence to account for. The rule is "explain a control the operator
   * expected", not "draw a control everywhere".
   */
  readonly offer: boolean;
}

/** The order matters: the first unmet condition is the one worth reporting. */
export function dispatchStanding(db: Db, boardId: string): DispatchStanding[] {
  const rows = db
    .select({
      id: cards.id,
      status: cards.status,
      archivedAt: cards.archivedAt,
      goalCondition: cards.goalCondition,
      isReady: columns.isReady,
      isTerminal: columns.isTerminal,
      columnName: columns.name,
    })
    .from(cards)
    .innerJoin(columns, eq(cards.columnId, columns.id))
    .where(eq(cards.boardId, boardId))
    .all();

  return rows.map((row) => ({
    id: row.id,
    reason: standingFor(db, row),
    offer: !row.isTerminal,
  }));
}

function standingFor(
  db: Db,
  row: {
    id: string;
    status: string;
    archivedAt: number | null;
    goalCondition: string | null;
    isReady: boolean;
    isTerminal: boolean;
    columnName: string;
  },
): string | null {
  // Running and archived first, because neither is a fault to be corrected -
  // one is already happening and the other was a decision.
  if (row.status === 'running') return null;
  if (row.archivedAt !== null) return 'This card is archived. Bring it back to dispatch it.';
  if (row.status !== 'idle') return `This card is ${row.status}, not idle.`;

  if (!row.isReady) {
    return `Only cards in a ready column can be dispatched. Move it out of ${row.columnName}.`;
  }

  // Said plainly and with the fix in it. A card dispatched without one halts
  // the queue with `no-goal`, so this is the check that saves a batch rather
  // than one card.
  if ((row.goalCondition ?? '').trim() === '') {
    return 'This card has no goal condition, so a run would have nothing to finish against. Write one in the specification.';
  }

  const blockers = blockersFor(db, row.id);
  if (blockers.length > 0) {
    return `Waiting on ${blockers.map((blocker) => `${blocker.title} (${blocker.status})`).join(', ')}.`;
  }

  return null;
}
