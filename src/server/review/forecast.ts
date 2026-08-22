import { existsSync } from 'node:fs';
import { simpleGit } from 'simple-git';

/**
 * Whether a merge would conflict, asked before committing to it (T39).
 *
 * The board can already merge, and can already resolve a conflict once it has
 * one. What it could not do is answer the question an operator asks first:
 * will this go in cleanly? Finding out by attempting the merge leaves a
 * half-merged working tree behind if the answer is no, which is a heavy price
 * for a question.
 *
 * `git merge-tree --write-tree` answers it without touching the working tree,
 * the index, or HEAD. Nothing is created that has to be cleaned up, so the
 * forecast is safe to ask for on every card, repeatedly, while looking.
 */

export interface MergeForecast {
  readonly clean: boolean;
  /** Paths git could not merge on its own. Empty when clean. */
  readonly conflicts: readonly string[];
  /**
   * False when the question could not be asked at all.
   *
   * Distinct from a conflict: a missing branch, a git too old for
   * `merge-tree --write-tree`, or a repository that is not there produce no
   * answer, and reporting that as "clean" would send the operator into a merge
   * on the strength of a check that never ran (R10).
   */
  readonly readable: boolean;
  readonly note: string;
}

export const UNKNOWN: MergeForecast = {
  clean: false,
  conflicts: [],
  readable: false,
  note: 'Whether this would merge cleanly could not be determined.',
};

/**
 * Reads the answer out of merge-tree's output.
 *
 * Not out of its exit code: `simple-git`'s `raw` resolves on exit 1, so the
 * code never reaches us. The output is the merged tree's object id, then the
 * conflicted paths, then git's own prose about what it tried. The prose is
 * dropped - it repeats the paths and reads as though the merge happened, when
 * nothing has.
 */
function conflictsFrom(output: string): string[] {
  const lines = output.split('\n').slice(1);
  const paths: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '') break;
    paths.push(trimmed);
  }

  return paths;
}

export async function forecastMerge(
  repoCwd: string,
  target: string | null,
  branch: string | null,
): Promise<MergeForecast> {
  if (target === null || branch === null || !existsSync(repoCwd)) return UNKNOWN;

  let output: string;
  try {
    output = await simpleGit(repoCwd).raw([
      'merge-tree',
      '--write-tree',
      '--name-only',
      target,
      branch,
    ]);
  } catch {
    // A missing branch, a repository that is not there, or a git too old for
    // `--write-tree`. No answer, which is not the same as a clean one.
    return UNKNOWN;
  }

  const conflicts = conflictsFrom(output);
  // Belt and braces: a conflict with no path listed is still a conflict, and
  // reporting it as clean is the one wrong answer this function can give.
  if (conflicts.length === 0 && !output.includes('CONFLICT')) {
    return {
      clean: true,
      conflicts: [],
      readable: true,
      note: `This would merge into ${target} cleanly.`,
    };
  }

  return {
    clean: false,
    conflicts,
    readable: true,
    note:
      conflicts.length === 0
        ? `This would not merge into ${target} cleanly.`
        : `${String(conflicts.length)} file(s) would conflict with ${target}: ${conflicts.join(', ')}.`,
  };
}
