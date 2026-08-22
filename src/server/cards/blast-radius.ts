import type { Database } from 'better-sqlite3';

import { similarity } from '../ledger/dedupe.js';
import { subsystemOf } from './subsystems.js';

/**
 * Guessing what a card will touch, from what similar cards did touch (T18).
 *
 * A card's scope guardrail is written by whoever wrote the card, which means
 * it is written before anyone knows the answer. The board, by now, has the
 * answer for every card it has run: the subsystem map says which files each
 * one actually changed.
 *
 * So a new card about the dispatcher can be told what the last three cards
 * about the dispatcher touched. This is a suggestion for the operator to
 * accept, edit or ignore - a scope the board set by itself would constrain an
 * agent on the strength of a guess about wording.
 */

export interface RadiusEntry {
  readonly path: string;
  /** How many similar cards touched it. Evidence, not confidence. */
  readonly cards: number;
}

export interface BlastRadius {
  readonly paths: readonly RadiusEntry[];
  readonly subsystems: readonly string[];
  /** The cards this was read from, so the operator can check the reasoning. */
  readonly from: readonly { readonly cardId: string; readonly title: string }[];
}

export const NOTHING: BlastRadius = { paths: [], subsystems: [], from: [] };

/**
 * Lower than the duplicate threshold, and for the opposite reason.
 *
 * A duplicate warning interrupts, so it has to be nearly certain. A blast
 * radius is offered rather than asserted, so a loose match that surfaces one
 * relevant file is worth more than silence.
 */
export const RELATED_THRESHOLD = 0.25;

export function proposeBlastRadius(
  sqlite: Database,
  boardId: string,
  title: string,
  excludeCardId?: string,
): BlastRadius {
  const trimmed = title.trim();
  if (trimmed === '') return NOTHING;

  const cards = sqlite
    .prepare(
      `SELECT DISTINCT cards.id AS id, cards.title AS title
       FROM cards
       JOIN card_paths ON card_paths.card_id = cards.id
       WHERE cards.board_id = ?`,
    )
    .all(boardId) as { id: string; title: string }[];

  const related = cards
    .filter((card) => card.id !== excludeCardId)
    .map((card) => ({ ...card, score: similarity(trimmed, card.title) }))
    .filter((card) => card.score >= RELATED_THRESHOLD)
    .sort((left, right) => right.score - left.score)
    // Three, not all of them. A radius assembled from every card that shares a
    // word is the whole repository, which is the same as no answer.
    .slice(0, 3);

  if (related.length === 0) return NOTHING;

  const counts = new Map<string, number>();
  for (const card of related) {
    const paths = sqlite
      .prepare('SELECT DISTINCT path FROM card_paths WHERE card_id = ?')
      .all(card.id) as { path: string }[];

    for (const row of paths) counts.set(row.path, (counts.get(row.path) ?? 0) + 1);
  }

  const paths = [...counts]
    .map(([path, cardCount]) => ({ path, cards: cardCount }))
    .sort((left, right) => right.cards - left.cards || left.path.localeCompare(right.path));

  return {
    paths,
    subsystems: [...new Set(paths.map((entry) => subsystemOf(entry.path)))],
    from: related.map((card) => ({ cardId: card.id, title: card.title })),
  };
}

/**
 * Said with its evidence attached.
 *
 * "These files" invites the operator to accept it. "These files, because these
 * three cards touched them" invites them to check, which is what they should
 * do with a guess derived from title similarity.
 */
export function describeBlastRadius(radius: BlastRadius): string | null {
  if (radius.paths.length === 0) return null;

  const titles = radius.from.map((card) => `"${card.title}"`).join(', ');

  return `${String(radius.paths.length)} path(s) in ${radius.subsystems.join(', ')}, from what ${titles} actually touched. A guess from similar wording - check it before relying on it.`;
}
