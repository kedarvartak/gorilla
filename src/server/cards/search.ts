import type { Database } from 'better-sqlite3';

/**
 * Finding a card again (T34).
 *
 * A board with sixty cards on it is a board where the operator's question is
 * "which card was the one about the dispatcher", and the only way to answer it
 * was to read every column. Once the subsystem map existed the interesting
 * half became possible: the card that touched a file is usually the card being
 * looked for, and its title may not mention the file at all.
 */

export interface SearchHit {
  readonly cardId: string;
  readonly title: string;
  /** Why this card matched, so a surprising hit explains itself. */
  readonly matched: readonly ('title' | 'body' | 'path')[];
  /** The path that matched, when one did. */
  readonly path: string | null;
}

/**
 * SQLite's LIKE is case-insensitive for ASCII, which is what identifiers are.
 * The escape keeps a query containing `%` or `_` from matching everything.
 */
function like(query: string): string {
  return `%${query.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

export function searchCards(sqlite: Database, boardId: string, query: string): SearchHit[] {
  const trimmed = query.trim();
  // An empty query matches everything, which as a search result is the same as
  // matching nothing and more confusing.
  if (trimmed === '') return [];

  const pattern = like(trimmed);

  const rows = sqlite
    .prepare(
      `SELECT
         cards.id AS cardId,
         cards.title AS title,
         cards.title LIKE ? ESCAPE '\\' AS byTitle,
         cards.body LIKE ? ESCAPE '\\' AS byBody,
         (SELECT card_paths.path FROM card_paths
            WHERE card_paths.card_id = cards.id AND card_paths.path LIKE ? ESCAPE '\\'
            ORDER BY card_paths.path LIMIT 1) AS byPath
       FROM cards
       WHERE cards.board_id = ?
       ORDER BY cards.position`,
    )
    .all(pattern, pattern, pattern, boardId) as {
    cardId: string;
    title: string;
    byTitle: number;
    byBody: number;
    byPath: string | null;
  }[];

  return rows
    .filter((row) => row.byTitle === 1 || row.byBody === 1 || row.byPath !== null)
    .map((row) => {
      const matched: ('title' | 'body' | 'path')[] = [];
      if (row.byTitle === 1) matched.push('title');
      if (row.byBody === 1) matched.push('body');
      if (row.byPath !== null) matched.push('path');

      return { cardId: row.cardId, title: row.title, matched, path: row.byPath };
    })
    .sort((left, right) => {
      // A title match first. Someone searching "dispatcher" who gets six cards
      // that merely edited the file, above the card called "the dispatcher",
      // has been given a worse answer than no search.
      const rank = (hit: SearchHit): number => (hit.matched.includes('title') ? 0 : 1);
      return rank(left) - rank(right);
    });
}
