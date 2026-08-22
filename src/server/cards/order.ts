import { asc, eq } from 'drizzle-orm';

import type { Db } from '../db/client.js';
import { cardDependencies, cards, columns } from '../db/schema.js';

/**
 * The order the remaining cards should be worked in (doc 05).
 *
 * A board answers "what is there" and a dependency answers "not yet". Neither
 * answers the question an operator actually asks when looking at fifteen cards:
 * *which one do I do first*. Working that out by eye means holding the priority
 * of every card and the whole dependency graph in your head at once, which is
 * the comprehension load this product exists to remove.
 *
 * Two rules, in this order:
 *
 * 1. **A card never ranks before something it depends on.** This is the hard
 *    constraint; everything else is a preference between cards that are equally
 *    free to run.
 * 2. **Among free cards, the queue's own order**: column, then priority, then
 *    position - the same key `dispatchableCards` sorts by. Using a different
 *    tie-break would print a number that disagrees with what the dispatcher
 *    actually does next, which is worse than printing nothing.
 *
 * Finished cards are excluded rather than ranked last: a number beside a done
 * card is an instruction to do something already done.
 */

const PRIORITY_RANK: Readonly<Record<string, number>> = { high: 0, normal: 1, low: 2 };

/** Statuses that mean the card is no longer work to be done. */
const FINISHED: ReadonlySet<string> = new Set(['done', 'abandoned']);

export interface RankedCard {
  readonly cardId: string;
  /** 1-based, and contiguous: the operator counts, they do not index. */
  readonly rank: number;
  /** True when something it depends on is still unfinished. */
  readonly blocked: boolean;
}

interface Pending {
  readonly id: string;
  readonly columnPosition: number;
  readonly priority: number;
  readonly position: number;
  readonly dependsOn: readonly string[];
}

function preference(a: Pending, b: Pending): number {
  if (a.columnPosition !== b.columnPosition) return a.columnPosition - b.columnPosition;
  if (a.priority !== b.priority) return a.priority - b.priority;
  return a.position - b.position;
}

export function executionOrder(db: Db, boardId: string): RankedCard[] {
  const columnPositions = new Map(
    db
      .select({ id: columns.id, position: columns.position })
      .from(columns)
      .where(eq(columns.boardId, boardId))
      .all()
      .map((column) => [column.id, column.position] as const),
  );

  const rows = db
    .select()
    .from(cards)
    .where(eq(cards.boardId, boardId))
    .orderBy(asc(cards.position))
    .all();

  // Archived cards are not work to be done either, for the same reason a done
  // one is not: a number beside a card nobody is going to run is an
  // instruction to do something the operator has already put away (T77).
  const unfinished = rows.filter((card) => !FINISHED.has(card.status) && card.archivedAt === null);
  const unfinishedIds = new Set(unfinished.map((card) => card.id));

  const edges = db.select().from(cardDependencies).all();

  const pending: Pending[] = unfinished.map((card) => ({
    id: card.id,
    columnPosition: columnPositions.get(card.columnId) ?? Number.MAX_SAFE_INTEGER,
    priority: PRIORITY_RANK[card.priority] ?? 1,
    position: card.position,
    // Only unfinished dependencies constrain anything. A dependency already
    // done is satisfied, and treating it as an edge would hold its dependant
    // back for ever.
    dependsOn: edges
      .filter((edge) => edge.cardId === card.id && unfinishedIds.has(edge.dependsOnCardId))
      .map((edge) => edge.dependsOnCardId),
  }));

  const ranked: RankedCard[] = [];
  const placed = new Set<string>();
  const remaining = [...pending];

  while (remaining.length > 0) {
    const free = remaining.filter((card) =>
      card.dependsOn.every((dependency) => placed.has(dependency)),
    );

    // Nothing free means a cycle. `wouldCycle` refuses those at write time, so
    // this is unreachable in practice - but ranking nothing would silently drop
    // cards from the interface, so the remainder is emitted in preference order
    // instead.
    const batch = free.length > 0 ? free : [...remaining];
    batch.sort(preference);

    const next = batch[0];
    if (next === undefined) break;

    ranked.push({
      cardId: next.id,
      rank: ranked.length + 1,
      blocked: next.dependsOn.length > 0,
    });
    placed.add(next.id);
    remaining.splice(
      remaining.findIndex((card) => card.id === next.id),
      1,
    );
  }

  return ranked;
}
