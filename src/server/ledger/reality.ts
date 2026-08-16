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
  /** Files the agent touched according to the event stream. */
  readonly claimedPaths: readonly string[];
  readonly git?: SimpleGit;
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
  try {
    headShaAtEnd = (await git.revparse(['HEAD'])).trim();
  } catch {
    // A repository with no commits yet. Working-tree status still works.
    headShaAtEnd = null;
  }

  const changed = new Set<string>();

  try {
    // Uncommitted work, which is the usual state at the end of a run.
    const status = await git.status();
    for (const file of [...status.files.map((f) => f.path), ...status.not_added]) {
      changed.add(normalise(file, input.cwd));
    }
  } catch (error) {
    return { ...UNAVAILABLE, reason: `Could not read git status: ${(error as Error).message}` };
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
