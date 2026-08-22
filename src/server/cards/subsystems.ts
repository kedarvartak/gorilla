import type { Database } from 'better-sqlite3';

/**
 * Which parts of the project a card touched (T13).
 *
 * Doc 12's project model needs to know that two cards worked on the same
 * thing. Nothing recorded it, so every cross-card question - what is the blast
 * radius here, which earlier card already learned this - had no data behind it
 * and stayed unbuilt. This is that data.
 *
 * Two sources, kept apart. Git is independent of the agent and is what the
 * branch actually holds. The tool events are the agent's own account of what
 * it edited. Merging them would lose the only comparison in the system able to
 * catch a run claiming work it did not do.
 */

export type PathSource = 'git' | 'claimed';

export interface CardPath {
  readonly path: string;
  readonly source: PathSource;
}

/**
 * The directory a path belongs to, two levels deep.
 *
 * Two levels because one is useless in this shape of project - everything is
 * `src` - and the full path is too specific to group anything: two cards that
 * both worked on the dispatcher would look unrelated because one touched
 * `dispatcher.ts` and the other `stall.ts`.
 */
export function subsystemOf(path: string): string {
  const parts = path.split('/').filter((part) => part !== '');
  if (parts.length <= 1) return parts[0] ?? path;
  return parts.slice(0, Math.min(2, parts.length - 1)).join('/');
}

export function recordCardPaths(
  sqlite: Database,
  cardId: string,
  paths: readonly string[],
  source: PathSource,
  now: number,
): number {
  // Deduplicated here rather than relying on the constraint, so the count
  // returned is paths recorded rather than statements attempted.
  const unique = [...new Set(paths.map((path) => path.trim()).filter((path) => path !== ''))];
  if (unique.length === 0) return 0;

  const insert = sqlite.prepare(
    'INSERT OR IGNORE INTO card_paths (card_id, path, source, recorded_at) VALUES (?, ?, ?, ?)',
  );

  sqlite.transaction(() => {
    for (const path of unique) insert.run(cardId, path, source, now);
  })();

  return unique.length;
}

export function pathsForCard(sqlite: Database, cardId: string): CardPath[] {
  return sqlite
    .prepare('SELECT path, source FROM card_paths WHERE card_id = ? ORDER BY path')
    .all(cardId) as CardPath[];
}

export interface SubsystemShare {
  readonly subsystem: string;
  readonly paths: number;
}

/** What a card worked on, grouped, so it can be said in a sentence. */
export function subsystemsForCard(sqlite: Database, cardId: string): SubsystemShare[] {
  const counts = new Map<string, number>();

  for (const entry of pathsForCard(sqlite, cardId)) {
    // Counted once per path however many sources reported it: this answers
    // "how much of this subsystem did the card touch", not "how many times was
    // it mentioned".
    const subsystem = subsystemOf(entry.path);
    counts.set(subsystem, (counts.get(subsystem) ?? 0) + 1);
  }

  return [...counts]
    .map(([subsystem, paths]) => ({ subsystem, paths }))
    .sort(
      (left, right) => right.paths - left.paths || left.subsystem.localeCompare(right.subsystem),
    );
}

export interface RelatedCard {
  readonly cardId: string;
  readonly title: string;
  readonly shared: readonly string[];
}

/**
 * Earlier cards that touched the same files.
 *
 * Ordered by how much they overlap, because a card that changed the same three
 * files is worth more to an operator than one that happened to touch a shared
 * type definition.
 */
export function cardsTouching(
  sqlite: Database,
  boardId: string,
  cardId: string,
  limit = 5,
): RelatedCard[] {
  const rows = sqlite
    .prepare(
      `SELECT other.card_id AS cardId, cards.title AS title, other.path AS path
       FROM card_paths AS mine
       JOIN card_paths AS other ON other.path = mine.path AND other.card_id <> mine.card_id
       JOIN cards ON cards.id = other.card_id
       WHERE mine.card_id = ? AND cards.board_id = ?
       GROUP BY other.card_id, other.path`,
    )
    .all(cardId, boardId) as { cardId: string; title: string; path: string }[];

  const grouped = new Map<string, { title: string; shared: string[] }>();
  for (const row of rows) {
    const existing = grouped.get(row.cardId);
    if (existing === undefined) {
      grouped.set(row.cardId, { title: row.title, shared: [row.path] });
      continue;
    }
    existing.shared.push(row.path);
  }

  return [...grouped]
    .map(([id, entry]) => ({ cardId: id, title: entry.title, shared: entry.shared.sort() }))
    .sort((left, right) => right.shared.length - left.shared.length)
    .slice(0, limit);
}

/**
 * Paths the run said it changed and git did not see.
 *
 * Not an accusation. Work reverted before the commit, files written outside
 * the worktree, and paths the mechanical ledger read out of a command line all
 * land here. It is a question worth surfacing, not a verdict, and it is
 * phrased that way wherever it is shown.
 */
export function claimedButNotInGit(sqlite: Database, cardId: string): string[] {
  const paths = pathsForCard(sqlite, cardId);
  const inGit = new Set(paths.filter((entry) => entry.source === 'git').map((entry) => entry.path));

  return paths
    .filter((entry) => entry.source === 'claimed' && !inGit.has(entry.path))
    .map((entry) => entry.path);
}
