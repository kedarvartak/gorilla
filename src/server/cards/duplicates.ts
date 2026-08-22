import type { Database } from 'better-sqlite3';

import { similarity } from '../ledger/dedupe.js';

/**
 * Noticing a card that restates one already on the board (T53).
 *
 * Cards arrive from a planning conversation in batches, and the same work gets
 * described twice with different words - once in the batch that planned it and
 * again three weeks later when nobody remembered. Two cards for one piece of
 * work is two worktrees, two branches, and a merge conflict between an agent
 * and itself.
 *
 * The same similarity the ledger uses for its own duplicates, deliberately.
 * A second notion of "the same thing" in one system is a second thing to tune
 * and a second thing to be wrong.
 */

export interface DuplicateWarning {
  readonly cardId: string;
  readonly title: string;
  /** 0..1. Reported so the operator can judge a borderline one themselves. */
  readonly similarity: number;
  readonly status: string;
}

/**
 * High, because the cost of the two errors is not symmetric.
 *
 * A missed duplicate costs one wasted card. A false one interrupts the
 * operator every time they add a card in a family they are already working
 * on - which is most of the time, since cards arrive in batches about one
 * subject.
 */
export const DUPLICATE_THRESHOLD = 0.6;

export function findDuplicates(
  sqlite: Database,
  boardId: string,
  title: string,
  excludeCardId?: string,
): DuplicateWarning[] {
  const trimmed = title.trim();
  if (trimmed === '') return [];

  const cards = sqlite
    .prepare('SELECT id, title, status FROM cards WHERE board_id = ?')
    .all(boardId) as { id: string; title: string; status: string }[];

  return (
    cards
      .filter((card) => card.id !== excludeCardId)
      // Abandoned cards are excluded: the operator already decided that work is
      // not happening, and warning about it invites them to un-decide by
      // accident. Done cards are kept - restating finished work is the mistake
      // this exists to catch.
      .filter((card) => card.status !== 'abandoned')
      .map((card) => ({
        cardId: card.id,
        title: card.title,
        similarity: similarity(trimmed, card.title),
        status: card.status,
      }))
      .filter((candidate) => candidate.similarity >= DUPLICATE_THRESHOLD)
      .sort((left, right) => right.similarity - left.similarity)
  );
}

/**
 * What to tell the operator, or null when there is nothing to say.
 *
 * A warning, never a refusal. Two cards that read alike are sometimes two
 * genuinely different pieces of work, and a board that refused the second
 * would be a board the operator learns to word their titles around.
 */
export function describeDuplicates(warnings: readonly DuplicateWarning[]): string | null {
  if (warnings.length === 0) return null;

  const first = warnings[0];
  if (first === undefined) return null;

  const others = warnings.length - 1;
  const more = others === 0 ? '' : ` (and ${String(others)} more)`;

  return `This reads like "${first.title}", which is already on the board and ${first.status}${more}. Added anyway - check it is not the same work.`;
}
