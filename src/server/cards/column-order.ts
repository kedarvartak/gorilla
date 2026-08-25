import { asc, eq } from 'drizzle-orm';

import { columns } from '../db/schema.js';
import type { Db } from '../db/client.js';

/**
 * Rearranging the columns of a board.
 *
 * Column order is board structure, not a viewing preference: it is the sequence
 * work moves through, the dispatcher reads it, and two operators looking at the
 * same board must see the same pipeline. So it is written to the database
 * rather than kept per-browser, which is the opposite of the collapse state
 * beside it in the interface.
 *
 * `(board_id, position)` is unique, so the positions cannot simply be assigned
 * in a loop: writing column B to position 1 while column A still holds it
 * fails, and which pairs collide depends on the permutation. Every rewrite
 * therefore parks the whole board outside the occupied range first.
 */

/** Far enough below any position a board could hold to be certainly free. */
const PARKED = -1_000_000;

export interface ColumnOrderResult {
  readonly ok: boolean;
  /** Why it was refused, for the caller to hand back verbatim. */
  readonly error?: string;
}

/**
 * Writes `orderedIds` as the board's column order.
 *
 * Refuses a partial list rather than appending what is missing. A caller that
 * sends four of five ids has read a stale board, and guessing where the fifth
 * belongs would silently move a column nobody dragged.
 */
export function reorderColumns(
  handle: { db: Db; sqlite: { transaction: <T>(fn: () => T) => () => T } },
  boardId: string,
  orderedIds: readonly string[],
): ColumnOrderResult {
  const existing = handle.db
    .select({ id: columns.id })
    .from(columns)
    .where(eq(columns.boardId, boardId))
    .orderBy(asc(columns.position))
    .all();

  if (existing.length === 0) return { ok: false, error: 'That board has no columns.' };

  const known = new Set(existing.map((row) => row.id));
  const seen = new Set<string>();

  for (const id of orderedIds) {
    if (!known.has(id)) return { ok: false, error: `No column ${id} on this board.` };
    if (seen.has(id)) return { ok: false, error: `Column ${id} appears twice.` };
    seen.add(id);
  }

  if (seen.size !== known.size) {
    return {
      ok: false,
      error: `Expected all ${String(known.size)} columns, got ${String(seen.size)}.`,
    };
  }

  handle.sqlite.transaction(() => {
    orderedIds.forEach((id, index) => {
      handle.db
        .update(columns)
        .set({ position: PARKED - index })
        .where(eq(columns.id, id))
        .run();
    });

    orderedIds.forEach((id, index) => {
      handle.db.update(columns).set({ position: index }).where(eq(columns.id, id)).run();
    });
  })();

  return { ok: true };
}
