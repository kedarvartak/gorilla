import { resolve } from 'node:path';

import { simpleGit, type SimpleGit } from 'simple-git';

/**
 * Checking what the agent said against what the repository did.
 *
 * Git is the only source here that is independent of the agent, so it is the
 * one that can contradict it. Two discrepancies matter, and they are not
 * symmetrical:
 *
 * - **Changed but never mentioned** is where unobserved drift lives. The
 *   operator has no reason to look at a file nobody talked about.
 * - **Mentioned but never changed** is milder - usually a file the agent read,
 *   considered and left alone - but it is worth knowing when the agent claimed
 *   to have done something it did not.
 */

export interface RealityInput {
  readonly cwd: string;
  readonly headShaAtStart: string | null;
  /**
   * Where the committed half of the diff ends. Omitted means the checkout's
   * current HEAD, which is right when `cwd` is the checkout the run worked in.
   */
  readonly headShaAtEnd?: string | null;
  /**
   * Whether uncommitted work in `cwd` counts. Only when `cwd` is the run's own
   * checkout: another checkout's working tree is someone else's work.
   */
  readonly includeWorkingTree?: boolean;
  /** Files the agent touched according to the event stream. */
  readonly claimedPaths: readonly string[];
  readonly git?: SimpleGit;
}

export interface RunRange {
  readonly cwd: string;
  readonly startedAt: number;
  readonly headShaAtStart: string | null;
  readonly headShaAtEnd: string | null;
}

/**
 * The commit range a card's work occupies, as seen from `cwd`.
 *
 * Starts at the first run's recorded HEAD. Before that column was written
 * (case study 1: null on every run) the committed half of the diff was never
 * taken, so an agent that committed its work - which is what agents are told
 * to do - showed "no files changed" and could never produce a
 * changed-but-unmentioned surprise.
 *
 * When `cwd` is the checkout the runs worked in, the range ends at its
 * current HEAD and the working tree counts. When it is some other checkout -
 * the board's own, after a card's worktree was removed - the range ends where
 * the last run left HEAD, and that checkout's uncommitted files are not the
 * card's. With no recorded end there is nothing honest to diff, so the
 * committed half is left out rather than diffed against unrelated history.
 */
export function rangeFor(
  runs: readonly RunRange[],
  cwd: string,
): Pick<RealityInput, 'headShaAtStart' | 'headShaAtEnd' | 'includeWorkingTree'> {
  const ordered = [...runs].sort((a, b) => a.startedAt - b.startedAt);
  const start = ordered.find((run) => run.headShaAtStart !== null)?.headShaAtStart ?? null;

  const here = resolve(cwd);
  const live = ordered.length === 0 || ordered.some((run) => resolve(run.cwd) === here);
  if (live) return { headShaAtStart: start, includeWorkingTree: true };

  const end = [...ordered].reverse().find((run) => run.headShaAtEnd !== null)?.headShaAtEnd ?? null;
  return {
    headShaAtStart: end === null ? null : start,
    headShaAtEnd: end,
    includeWorkingTree: false,
  };
}

export interface RealityCheck {
  readonly available: boolean;
  readonly reason?: string;
  readonly changedFiles: readonly string[];
  /** Changed on disk, absent from the event stream. Where drift hides. */
  readonly changedButUnmentioned: readonly string[];
  /** In the event stream, unchanged on disk. */
  readonly mentionedButUnchanged: readonly string[];
  readonly headShaAtEnd: string | null;
}

const UNAVAILABLE: RealityCheck = {
  available: false,
  changedFiles: [],
  changedButUnmentioned: [],
  mentionedButUnchanged: [],
  headShaAtEnd: null,
};

/** Compares against a path list, so absolute and relative forms both match. */
function normalise(path: string, cwd: string): string {
  const stripped = path.startsWith(cwd) ? path.slice(cwd.length) : path;
  return stripped.replace(/^[/\\]+/, '');
}

/**
 * Never throws. A repository that is not a repository, a missing base commit,
 * or a git binary that is absent all degrade to "not available" with a reason,
 * because a diagnostic that crashes is worse than no diagnostic (P7).
 */
export async function checkReality(input: RealityInput): Promise<RealityCheck> {
  // simpleGit() throws synchronously when the directory does not exist, so it
  // is constructed inside the guard. This module promises never to throw, and
  // a working directory deleted mid-run is a real case.
  let git: SimpleGit;
  try {
    git = input.git ?? simpleGit(input.cwd);
    if (!(await git.checkIsRepo())) {
      return { ...UNAVAILABLE, reason: 'Not a git repository.' };
    }
  } catch (error) {
    return { ...UNAVAILABLE, reason: `git is unavailable: ${(error as Error).message}` };
  }

  let headShaAtEnd: string | null = null;
  if (input.headShaAtEnd !== undefined) {
    headShaAtEnd = input.headShaAtEnd;
  } else {
    try {
      headShaAtEnd = (await git.revparse(['HEAD'])).trim();
    } catch {
      // A repository with no commits yet. Working-tree status still works.
      headShaAtEnd = null;
    }
  }

  const changed = new Set<string>();

  if (input.includeWorkingTree !== false) {
    try {
      // Uncommitted work, which is the usual state at the end of a run.
      const status = await git.status();
      for (const file of [...status.files.map((f) => f.path), ...status.not_added]) {
        changed.add(normalise(file, input.cwd));
      }
    } catch (error) {
      return { ...UNAVAILABLE, reason: `Could not read git status: ${(error as Error).message}` };
    }
  }

  if (input.headShaAtStart !== null && headShaAtEnd !== null) {
    try {
      const diff = await git.diff(['--name-only', `${input.headShaAtStart}..${headShaAtEnd}`]);
      for (const line of diff.split('\n')) {
        if (line.trim() !== '') changed.add(normalise(line.trim(), input.cwd));
      }
    } catch {
      // A base commit that no longer exists, after a rebase or a reset. The
      // working-tree half is still valid, so report what we have.
    }
  }

  const claimed = new Set(input.claimedPaths.map((path) => normalise(path, input.cwd)));

  return {
    available: true,
    changedFiles: [...changed].sort(),
    changedButUnmentioned: [...changed].filter((file) => !claimed.has(file)).sort(),
    mentionedButUnchanged: [...claimed].filter((file) => !changed.has(file)).sort(),
    headShaAtEnd,
  };
}

export function describeReality(check: RealityCheck): string[] {
  if (!check.available) {
    return [`Git comparison unavailable: ${check.reason ?? 'unknown reason'}`];
  }

  const lines: string[] = [`${check.changedFiles.length} file(s) changed according to git.`];

  if (check.changedButUnmentioned.length > 0) {
    lines.push(
      `${check.changedButUnmentioned.length} changed without appearing in the event stream: ` +
        check.changedButUnmentioned.join(', '),
    );
  }
  if (check.mentionedButUnchanged.length > 0) {
    lines.push(
      `${check.mentionedButUnchanged.length} touched by a tool but unchanged on disk: ` +
        check.mentionedButUnchanged.join(', '),
    );
  }
  if (check.changedButUnmentioned.length === 0 && check.mentionedButUnchanged.length === 0) {
    lines.push('The event stream and the repository agree.');
  }

  return lines;
}
