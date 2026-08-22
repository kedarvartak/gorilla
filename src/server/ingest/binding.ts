import { existsSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

import type Database from 'better-sqlite3';

/**
 * Resolves an incoming event's `(session_id, cwd)` to a run (doc 05).
 *
 * Phase 0 implements only the inferred half of the binding: an unrecognised
 * session in an unrecognised directory still gets a board and a run, because an
 * event that arrives with nowhere to go is the blind spot the product exists to
 * remove. Launched and declared binding arrive with cards in Phase 1.
 *
 * Written against better-sqlite3 directly rather than the query builder: this
 * sits on the hook path, where the latency budget is 25ms p99 (doc 06), and
 * prepared statements reused across requests are materially cheaper.
 */

export interface ResolvedRun {
  readonly runId: string;
  readonly boardId: string;
  readonly created: boolean;
}

/**
 * Canonicalises a working directory so two spellings of the same path route to
 * one board. Falls back to `resolve` when the path does not exist, which
 * happens in tests and when a directory has since been deleted.
 */
export function canonicaliseCwd(cwd: string): string {
  const absolute = resolve(cwd);
  if (!existsSync(absolute)) return absolute;
  try {
    return realpathSync(absolute);
  } catch {
    return absolute;
  }
}

/**
 * The board a directory belongs to, which is not always the directory (T67).
 *
 * A dispatched card runs in `<board>/.gorilla/worktrees/<cardId>`, and its
 * session reports that path as its cwd. Taken literally, every card the board
 * ever dispatched becomes a board of its own, named after a uuid, holding the
 * runs that should have been attributed to the project. Found by running
 * `gorilla status` against a real database and seeing five boards where there
 * is one project.
 *
 * The worktrees live at a path this system chose, so recognising them is not a
 * heuristic about directory names - it is reading back a convention the board
 * wrote itself.
 */
export function owningBoardCwd(cwd: string): string {
  const canonical = canonicaliseCwd(cwd);
  const marker = canonical.includes('\\') ? '\\.gorilla\\worktrees\\' : '/.gorilla/worktrees/';
  const at = canonical.indexOf(marker);

  // Not in a worktree, or is the worktrees directory itself rather than a card
  // inside it. Either way the directory is its own board.
  if (at <= 0) return canonical;

  return canonical.slice(0, at);
}

function boardNameFor(cwd: string): string {
  const segments = canonicaliseCwd(cwd).split(/[/\\]/).filter(Boolean);
  return segments[segments.length - 1] ?? cwd;
}

export class BindingResolver {
  readonly #selectBoard: Database.Statement<[string], { id: string }>;
  readonly #insertBoard: Database.Statement<[string, string, string, number]>;
  readonly #selectRun: Database.Statement<[string], { id: string; board_id: string }>;
  readonly #insertRun: Database.Statement<[string, string, string, string, number, string | null]>;

  /** Boards change rarely; caching avoids a query per event. */
  readonly #boardCache = new Map<string, string>();

  constructor(private readonly sqlite: Database.Database) {
    this.#selectBoard = sqlite.prepare('SELECT id FROM boards WHERE cwd = ?');
    this.#insertBoard = sqlite.prepare(
      'INSERT INTO boards (id, name, cwd, created_at) VALUES (?, ?, ?, ?)',
    );
    this.#selectRun = sqlite.prepare('SELECT id, board_id FROM runs WHERE session_id = ?');
    this.#insertRun = sqlite.prepare(
      'INSERT INTO runs (id, board_id, session_id, cwd, started_at, transcript_path) VALUES (?, ?, ?, ?, ?, ?)',
    );
  }

  boardForCwd(cwd: string): string {
    // The owning project, not the worktree. A card's session reports its
    // worktree as its cwd, and taking that literally gives every dispatched
    // card a board of its own (T67).
    const canonical = owningBoardCwd(cwd);

    const cached = this.#boardCache.get(canonical);
    if (cached !== undefined) return cached;

    const existing = this.#selectBoard.get(canonical);
    if (existing !== undefined) {
      this.#boardCache.set(canonical, existing.id);
      return existing.id;
    }

    const id = randomUUID();
    this.#insertBoard.run(id, boardNameFor(canonical), canonical, Date.now());
    this.#boardCache.set(canonical, id);
    return id;
  }

  resolve(sessionId: string, cwd: string, transcriptPath: string | null): ResolvedRun {
    const existing = this.#selectRun.get(sessionId);
    if (existing !== undefined) {
      return { runId: existing.id, boardId: existing.board_id, created: false };
    }

    const boardId = this.boardForCwd(cwd);
    const runId = randomUUID();
    this.#insertRun.run(
      runId,
      boardId,
      sessionId,
      canonicaliseCwd(cwd),
      Date.now(),
      transcriptPath,
    );

    return { runId, boardId, created: true };
  }
}
