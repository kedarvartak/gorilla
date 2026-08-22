import { existsSync } from 'node:fs';
import { simpleGit } from 'simple-git';

/**
 * What a card's branch actually changed (T30, T31).
 *
 * Reviewing a card meant leaving the board for a terminal, which is the point
 * at which the operator loses the context the board exists to hold. They come
 * back having read a diff and no longer remember which of the eleven cards
 * they were looking at.
 *
 * Read from git, against the merge base, so it is the card's own work rather
 * than everything that has happened on the target branch since.
 */

export interface FileChange {
  readonly path: string;
  readonly insertions: number;
  readonly deletions: number;
  /** True for a file git cannot diff as text. Its counts are meaningless. */
  readonly binary: boolean;
}

export interface DiffSummary {
  readonly files: readonly FileChange[];
  readonly insertions: number;
  readonly deletions: number;
  /**
   * Null when the branch could not be read, which is not the same as a branch
   * with no changes. A merged card's branch is usually gone, and reporting
   * that as "changed nothing" would rewrite its history.
   */
  readonly readable: boolean;
}

export const UNREADABLE: DiffSummary = {
  files: [],
  insertions: 0,
  deletions: 0,
  readable: false,
};

/**
 * A cap on what one request will read.
 *
 * A card that rewrote three hundred files is a card whose diff nobody is going
 * to read in a side panel, and sending it turns a review screen into a
 * download. The count is still reported truthfully - see `truncated`.
 */
export const MAX_FILES = 200;

export async function diffSummary(
  repoCwd: string,
  branch: string | null,
  base = 'HEAD',
): Promise<DiffSummary> {
  if (branch === null || !existsSync(repoCwd)) return UNREADABLE;

  try {
    // Three dots: against the merge base. Two would include everything that
    // landed on the target since the card branched, which is not its work.
    const summary = await simpleGit(repoCwd).diffSummary([`${base}...${branch}`]);

    const files: FileChange[] = summary.files.slice(0, MAX_FILES).map((file) =>
      file.binary
        ? // Git reports no line counts for a binary file. Zeroes here would
          // read as "changed nothing", so the flag travels with them.
          { path: file.file, insertions: 0, deletions: 0, binary: true }
        : {
            path: file.file,
            insertions: file.insertions,
            deletions: file.deletions,
            binary: false,
          },
    );

    return {
      files,
      insertions: summary.insertions,
      deletions: summary.deletions,
      readable: true,
    };
  } catch {
    // A deleted branch is the normal end state of a merged card, so this is an
    // expected miss rather than a failure.
    return UNREADABLE;
  }
}

/** How the summary reads in a sentence. */
export function describeDiff(summary: DiffSummary): string {
  if (!summary.readable) {
    return 'The branch could not be read. A merged card has usually had its branch removed.';
  }
  if (summary.files.length === 0) return 'The branch changes nothing.';

  return `${String(summary.files.length)} file(s), +${String(summary.insertions)} -${String(summary.deletions)}.`;
}

/**
 * The diff of one file.
 *
 * One file at a time, because the whole diff of a real card is megabytes and
 * an operator reads it one file at a time anyway. The path is passed to git
 * after `--`, so a path that looks like a flag cannot become one.
 */
export async function fileDiff(
  repoCwd: string,
  branch: string | null,
  path: string,
  base = 'HEAD',
): Promise<string | null> {
  if (branch === null || !existsSync(repoCwd)) return null;

  try {
    return await simpleGit(repoCwd).raw(['diff', `${base}...${branch}`, '--', path]);
  } catch {
    return null;
  }
}
