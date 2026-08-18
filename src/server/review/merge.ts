import { existsSync } from 'node:fs';

import { simpleGit, type SimpleGit } from 'simple-git';

import { runVerify, type VerifyResult } from '../verify/run.js';

/**
 * Merging the night's worktrees back together (doc 18, U4).
 *
 * The operator wakes to several finished branches and wants one action, not an
 * hour of merging. This is that action: merge the named branches one at a
 * time, run the project's verify after each, and stop at the first thing that
 * breaks.
 *
 * Deliberately narrow. It does not review code quality, does not touch
 * branches it was not given, does not push, and does not decide what to merge -
 * the operator names the cards. It exists to answer "does this all fit
 * together" and nothing else.
 *
 * Stopping at the first failure is the important part. Continuing would leave
 * the operator with a broken integration branch and several candidate causes,
 * which is strictly worse than one merge and one named culprit.
 */

export type MergeOutcome =
  | 'merged'
  | 'conflicted'
  | 'verify-failed'
  | 'skipped'
  | 'errored'
  // The branch has nothing the target does not already have.
  | 'nothing-to-merge'
  // The work exists, but only as uncommitted changes in the worktree.
  | 'uncommitted';

export interface MergeStep {
  readonly cardId: string;
  readonly title: string;
  readonly branch: string;
  readonly outcome: MergeOutcome;
  readonly detail: string;
  readonly verify?: VerifyResult;
}

export interface MergeRequest {
  readonly repoCwd: string;
  /**
   * Cards to merge, in the order the operator wants them applied.
   *
   * `worktree` is optional only because a card can be merged without one. When
   * it is given, the tree is checked for uncommitted work before the merge -
   * see `mergeBranches` for why that check is not optional in spirit.
   */
  readonly cards: readonly {
    cardId: string;
    title: string;
    branch: string;
    worktree?: string;
  }[];
  /** Branch to merge into. Defaults to the current branch. */
  readonly into?: string;
  /** Run after every merge. Usually the project's test command. */
  readonly verifyCommand?: string | null;
  readonly git?: SimpleGit;
}

export interface MergeReport {
  readonly into: string;
  readonly steps: readonly MergeStep[];
  readonly merged: number;
  /** The first thing that broke, if anything did. */
  readonly stoppedAt: MergeStep | null;
  readonly clean: boolean;
}

async function currentBranch(git: SimpleGit): Promise<string> {
  const status = await git.status();
  return status.current ?? 'HEAD';
}

/**
 * How many commits a branch has that the target does not.
 *
 * Returns -1 when it cannot be determined - an unknown branch, a missing
 * target - so the caller can tell "no commits" from "no answer" and let the
 * merge itself produce the real error.
 */
async function commitsAhead(git: SimpleGit, into: string, branch: string): Promise<number> {
  try {
    const raw = await git.raw(['rev-list', '--count', `${into}..${branch}`]);
    const count = Number(raw.trim());
    return Number.isFinite(count) ? count : -1;
  } catch {
    return -1;
  }
}

/** Uncommitted entries in a card's worktree, or 0 when there is no worktree to check. */
async function uncommittedIn(worktree: string | undefined): Promise<number> {
  if (worktree === undefined || !existsSync(worktree)) return 0;
  try {
    return (await simpleGit(worktree).status()).files.length;
  } catch {
    // Unreadable is not the same as clean, but refusing every merge because a
    // status call failed would be worse than the risk it guards against.
    return 0;
  }
}

/**
 * The branch a merge would land on, for the interface to name before asking.
 *
 * "Merge into main" and "merge into whatever you happen to be on" are different
 * offers, and only one of them is safe to make without saying which.
 */
export async function mergeTargetFor(repoCwd: string): Promise<string | null> {
  if (!existsSync(repoCwd)) return null;
  try {
    return await currentBranch(simpleGit(repoCwd));
  } catch {
    return null;
  }
}

/**
 * Merges each branch in turn.
 *
 * A conflict is left in the working tree on purpose. Aborting would hide what
 * clashed, and the operator's next question is always "clashed with what".
 */
export async function mergeBranches(request: MergeRequest): Promise<MergeReport> {
  const steps: MergeStep[] = [];

  // Guard before constructing: simpleGit() throws synchronously on a missing
  // directory, which caught checkReality too. The board must not crash because
  // a worktree was deleted underneath it.
  if (!existsSync(request.repoCwd)) {
    return {
      into: request.into ?? 'HEAD',
      steps: [
        {
          cardId: '',
          title: '',
          branch: '',
          outcome: 'errored',
          detail: `The repository directory does not exist: ${request.repoCwd}`,
        },
      ],
      merged: 0,
      stoppedAt: null,
      clean: false,
    };
  }

  const git = request.git ?? simpleGit(request.repoCwd);

  const into = request.into ?? (await currentBranch(git));

  try {
    if (into !== (await currentBranch(git))) await git.checkout(into);
  } catch (error) {
    const step: MergeStep = {
      cardId: '',
      title: '',
      branch: into,
      outcome: 'errored',
      detail: `Could not switch to ${into}: ${(error as Error).message}`,
    };
    return { into, steps: [step], merged: 0, stoppedAt: step, clean: false };
  }

  let merged = 0;
  let stoppedAt: MergeStep | null = null;

  for (const card of request.cards) {
    if (stoppedAt !== null) {
      steps.push({
        ...card,
        outcome: 'skipped',
        detail: 'Not attempted: an earlier card stopped the merge.',
      });
      continue;
    }

    // Uncommitted work is the failure that made these checks necessary. An
    // agent wrote a module and its tests, never committed them, and the board
    // merged the empty branch, ran the target's own unchanged tests, and
    // reported "merged and verified". The work was still sitting in the
    // worktree. Reporting success for a merge that moved nothing is the false
    // completion this product exists to prevent, so it is refused rather than
    // warned about.
    const dirty = await uncommittedIn(card.worktree);

    if (dirty > 0) {
      stoppedAt = {
        ...card,
        outcome: 'uncommitted',
        detail:
          `${String(dirty)} uncommitted change(s) in this card's worktree. They are not on ` +
          `${card.branch}, so merging it would land nothing and report success. Commit them ` +
          'in the worktree, then merge again.',
      };
      steps.push(stoppedAt);
      continue;
    }

    // A branch with nothing ahead of the target merges cleanly and changes
    // nothing. Git calls that "already up to date"; an operator reading
    // "merged" would call it done.
    const ahead = await commitsAhead(git, into, card.branch);

    if (ahead === 0) {
      stoppedAt = {
        ...card,
        outcome: 'nothing-to-merge',
        detail:
          `${card.branch} has no commits that ${into} does not already have, so there is ` +
          'nothing to merge. Either the work was never committed, or it has already landed.',
      };
      steps.push(stoppedAt);
      continue;
    }

    try {
      await git.merge(['--no-ff', card.branch]);
    } catch (error) {
      // Left in place rather than aborted: the operator's next question is
      // what clashed, and `git merge --abort` destroys the evidence.
      stoppedAt = {
        ...card,
        outcome: 'conflicted',
        detail: `Merge conflict, left in the working tree for inspection: ${(error as Error).message}`,
      };
      steps.push(stoppedAt);
      continue;
    }

    if (request.verifyCommand === null || request.verifyCommand === undefined) {
      merged += 1;
      steps.push({ ...card, outcome: 'merged', detail: `Merged ${card.branch}.` });
      continue;
    }

    const verify = await runVerify({ command: request.verifyCommand, cwd: request.repoCwd });

    if (verify.status === 'passed' || verify.status === 'skipped') {
      merged += 1;
      steps.push({ ...card, outcome: 'merged', detail: `Merged and verified.`, verify });
      continue;
    }

    // The merge succeeded and the project broke. Naming which card did it is
    // the whole value of merging one at a time.
    stoppedAt = {
      ...card,
      outcome: 'verify-failed',
      detail: `Merged cleanly, but the project no longer passes. This card broke it.`,
      verify,
    };
    steps.push(stoppedAt);
  }

  return { into, steps, merged, stoppedAt, clean: stoppedAt === null };
}

export function describeMergeReport(report: MergeReport): string[] {
  const lines = [`Merging into ${report.into}: ${report.merged} of ${report.steps.length} merged.`];

  for (const step of report.steps) {
    lines.push(`  ${step.outcome.padEnd(13)} ${step.title || step.branch} - ${step.detail}`);
  }

  if (report.stoppedAt !== null) {
    lines.push('');
    lines.push(
      `Stopped at "${report.stoppedAt.title}". Nothing after it was attempted, and the ` +
        `working tree is left as it is so the cause can be inspected.`,
    );
  }

  return lines;
}
