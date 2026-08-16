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

export type MergeOutcome = 'merged' | 'conflicted' | 'verify-failed' | 'skipped' | 'errored';

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
  /** Cards to merge, in the order the operator wants them applied. */
  readonly cards: readonly { cardId: string; title: string; branch: string }[];
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
