import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';

import { simpleGit, type SimpleGit } from 'simple-git';

/**
 * A git worktree per dispatched card (doc 18, U2).
 *
 * Several agents editing one checkout overwrite each other, which is why
 * concurrency defaulted to one. Isolation is what makes an overnight queue
 * possible, and it is also what makes it safe to stop halting on success: a
 * later card cannot see an earlier card's unmerged work unless it declared a
 * dependency, in which case the graph already sequences them.
 *
 * The strong rule here is that **a worktree is never removed automatically**.
 * It holds a night of the agent's work, and deleting it because a process
 * restarted or a card looked finished is unrecoverable. Removal is an operator
 * action, after merging or abandoning.
 */

export const WORKTREE_DIR = '.gorilla/worktrees';
export const BRANCH_PREFIX = 'gorilla';

export interface Workspace {
  readonly cardId: string;
  readonly path: string;
  readonly branch: string;
  readonly baseRef: string;
  readonly created: boolean;
}

export interface WorktreeError {
  readonly ok: false;
  readonly reason: string;
}

export type WorktreeResult = ({ ok: true } & Workspace) | WorktreeError;

/** Branch names must survive a title someone typed in a hurry. */
export function branchNameFor(cardId: string, title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);

  const suffix = cardId.slice(0, 8);
  return slug === '' ? `${BRANCH_PREFIX}/${suffix}` : `${BRANCH_PREFIX}/${slug}-${suffix}`;
}

export function workspacePathFor(boardCwd: string, cardId: string): string {
  return join(boardCwd, WORKTREE_DIR, cardId);
}

export class WorktreeManager {
  readonly #known = new Map<string, Workspace>();

  constructor(private readonly boardCwd: string) {}

  /** The worktree for a card, if one has been created. */
  pathFor(cardId: string): string | undefined {
    return this.#known.get(cardId)?.path;
  }

  workspaceFor(cardId: string): Workspace | undefined {
    return this.#known.get(cardId);
  }

  list(): readonly Workspace[] {
    return [...this.#known.values()];
  }

  #git(): SimpleGit {
    return simpleGit(this.boardCwd);
  }

  /**
   * Rediscovers worktrees that already exist on disk.
   *
   * `#known` is an in-memory map filled only by `create`, so every restart used
   * to forget every worktree. The consequences were not cosmetic: a card's
   * merge button reported "no worktree" for a branch sitting right there, the
   * reviewer refused to merge it, and - worst - `#workspacePath` fell back to
   * the board's own checkout, so re-dispatching a card after a restart would
   * silently un-isolate it and run the agent in the operator's working tree.
   *
   * Worktrees are durable and git already tracks them, so the board should ask
   * rather than remember. Called at startup, next to the run reconciliation
   * that exists for the same reason.
   */
  async adopt(): Promise<number> {
    if (!existsSync(this.boardCwd)) return 0;

    let raw: string;
    try {
      raw = await this.#git().raw(['worktree', 'list', '--porcelain']);
    } catch {
      // Not a repository, or git is unavailable. Isolation is already off in
      // that case; there is nothing to rediscover.
      return 0;
    }

    const prefix = join(this.boardCwd, WORKTREE_DIR);
    let adopted = 0;
    let path: string | null = null;

    for (const line of raw.split('\n')) {
      if (line.startsWith('worktree ')) {
        path = line.slice('worktree '.length).trim();
        continue;
      }

      // `branch refs/heads/x` closes the record for the path above it.
      if (!line.startsWith('branch ') || path === null) continue;

      const branch = line
        .slice('branch '.length)
        .trim()
        .replace(/^refs\/heads\//, '');
      const candidate = path;
      path = null;

      if (!candidate.startsWith(prefix)) continue;

      // The directory is named for the card, which is what makes rediscovery
      // possible at all without a table of our own.
      const cardId = basename(candidate);
      if (cardId === '' || this.#known.has(cardId)) continue;

      this.#known.set(cardId, {
        cardId,
        path: candidate,
        branch,
        // Unknowable after the fact: git records where a branch points now, not
        // what it was cut from. Empty says so rather than inventing a ref.
        baseRef: '',
        // Adopted, not created by this process. The distinction matters to any
        // caller deciding whether it is looking at fresh work.
        created: false,
      });
      adopted += 1;
    }

    return adopted;
  }

  /**
   * Creates the worktree for a card, or adopts the existing one.
   *
   * `baseRef` lets a dependent card branch from its dependency's branch rather
   * than from HEAD, so declared work composes while undeclared work stays
   * isolated (doc 18).
   */
  async create(cardId: string, title: string, baseRef?: string): Promise<WorktreeResult> {
    const path = workspacePathFor(this.boardCwd, cardId);
    const branch = branchNameFor(cardId, title);

    const existing = this.#known.get(cardId);
    if (existing !== undefined && existsSync(existing.path)) {
      return { ok: true, ...existing, created: false };
    }

    // Adopting rather than failing matters after a board restart: the worktree
    // outlives the process that made it, and the work in it is the deliverable.
    if (existsSync(path)) {
      const adopted: Workspace = {
        cardId,
        path,
        branch,
        baseRef: baseRef ?? 'HEAD',
        created: false,
      };
      this.#known.set(cardId, adopted);
      return { ok: true, ...adopted };
    }

    const git = this.#git();

    try {
      if (!(await git.checkIsRepo())) {
        return { ok: false, reason: 'The board directory is not a git repository.' };
      }
    } catch (error) {
      return { ok: false, reason: `git is unavailable: ${(error as Error).message}` };
    }

    const base = baseRef ?? 'HEAD';

    try {
      mkdirSync(join(this.boardCwd, WORKTREE_DIR), { recursive: true });

      const branches = await git.branch();
      const args = branches.all.includes(branch)
        ? ['worktree', 'add', path, branch]
        : ['worktree', 'add', '-b', branch, path, base];

      await git.raw(args);
    } catch (error) {
      return { ok: false, reason: `Could not create a worktree: ${(error as Error).message}` };
    }

    const workspace: Workspace = { cardId, path, branch, baseRef: base, created: true };
    this.#known.set(cardId, workspace);

    return { ok: true, ...workspace };
  }

  /**
   * Removes a worktree. Only ever called for a card the operator has merged or
   * abandoned - never on completion, never on restart, never on failure. A
   * failed run's worktree is usually the thing that needs looking at.
   */
  async remove(cardId: string, options: { force?: boolean } = {}): Promise<WorktreeResult> {
    const workspace = this.#known.get(cardId) ?? {
      cardId,
      path: workspacePathFor(this.boardCwd, cardId),
      branch: '',
      baseRef: 'HEAD',
      created: false,
    };

    if (!existsSync(workspace.path)) {
      this.#known.delete(cardId);
      return { ok: true, ...workspace, created: false };
    }

    try {
      await this.#git().raw(
        options.force === true
          ? ['worktree', 'remove', '--force', workspace.path]
          : ['worktree', 'remove', workspace.path],
      );
    } catch (error) {
      // Uncommitted changes are the usual cause, and refusing is correct: the
      // operator asked to tidy up, not to discard work they have not seen.
      return { ok: false, reason: `Could not remove the worktree: ${(error as Error).message}` };
    }

    this.#known.delete(cardId);
    return { ok: true, ...workspace, created: false };
  }

  /** Uncommitted work in a card's worktree, which review has to account for. */
  async statusOf(cardId: string): Promise<{ branch: string; dirty: number; ahead: number } | null> {
    const workspace = this.#known.get(cardId);
    if (workspace === undefined || !existsSync(workspace.path)) return null;

    try {
      const git = simpleGit(workspace.path);
      const status = await git.status();

      return {
        branch: status.current ?? workspace.branch,
        dirty: status.files.length,
        ahead: status.ahead,
      };
    } catch {
      return null;
    }
  }

  /** Discards the manager's memory without touching disk. For tests. */
  forget(): void {
    this.#known.clear();
  }
}

/** Removes a worktree directory outright. Only for tests and forced cleanup. */
export function purgeWorktreeDirectory(boardCwd: string): void {
  rmSync(join(boardCwd, WORKTREE_DIR), { recursive: true, force: true });
}
