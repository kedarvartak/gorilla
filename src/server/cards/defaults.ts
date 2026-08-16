import { randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';

import type { Db } from '../db/client.js';
import { boards, cards, columns, type NewColumn } from '../db/schema.js';

/**
 * The default column set (doc 05), which mirrors the ACE-FCA research, plan,
 * implement loop rather than a generic Todo/Doing/Done.
 */
export const DEFAULT_COLUMNS: readonly Omit<NewColumn, 'id' | 'boardId'>[] = [
  { name: 'Intake', position: 0 },
  { name: 'Ready', position: 1, isReady: true },
  { name: 'Running', position: 2 },
  { name: 'Needs Review', position: 3, isReviewGate: true },
  { name: 'Done', position: 4, isTerminal: true },
];

/** Creates the default columns for a board. Idempotent per board. */
export function createDefaultColumns(db: Db, boardId: string): void {
  const existing = db.select({ id: columns.id }).from(columns).all();
  if (existing.length > 0) return;

  for (const column of DEFAULT_COLUMNS) {
    db.insert(columns)
      .values({ ...column, id: randomUUID(), boardId })
      .run();
  }
}

/**
 * Deletes a board and everything under it, in dependency order.
 *
 * Cards reference columns with `restrict` on purpose: deleting a column that
 * still holds cards should fail loudly rather than silently discard work. That
 * protection also blocks the cascade from a board deletion, so board removal is
 * an explicit ordered operation inside one transaction rather than a single
 * DELETE that half-succeeds.
 */
export function deleteBoard(
  handle: { db: Db; sqlite: { transaction: <T>(fn: () => T) => () => T } },
  boardId: string,
): void {
  handle.sqlite.transaction(() => {
    handle.db.delete(cards).where(eq(cards.boardId, boardId)).run();
    handle.db.delete(columns).where(eq(columns.boardId, boardId)).run();
    handle.db.delete(boards).where(eq(boards.id, boardId)).run();
  })();
}
