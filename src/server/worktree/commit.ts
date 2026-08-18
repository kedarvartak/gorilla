import { existsSync } from 'node:fs';

import { simpleGit } from 'simple-git';

/**
 * Committing a finished card's work to its own branch (doc 18).
 *
 * The board owns the worktree and the branch, so it owns the invariant that a
 * finished card's work is *on* that branch. Leaving that to the agent failed
 * twice in a row: both times the work existed, the tests passed, and the branch
 * was empty, because nothing had ever told the agent it was on a branch at all.
 *
 * The launch context now says so, which is the fix that produces good commits -
 * an agent that commits as it goes writes better messages than anything here
 * could. This is the floor underneath that: whatever is still uncommitted when
 * the run ends gets committed, so "the card finished" and "the work is on the
 * branch" cannot come apart.
 *
 * Only after a run that completed. Committing the leavings of a failed or
 * cancelled run would put half-finished work on a branch that reads as ready.
 */

export interface CommitResult {
  readonly committed: boolean;
  /** Files in the commit, or still uncommitted if it failed. */
  readonly files: number;
  readonly reason?: string;
}

export function boardCommitMessage(cardTitle: string, cardId: string): string {
  return [
    cardTitle,
    '',
    'Committed by the board when the run finished, because uncommitted work is',
    'not on the branch and would not be merged.',
    '',
    `Card: ${cardId}`,
  ].join('\n');
}

export async function commitWorkspace(input: {
  cwd: string;
  cardId: string;
  cardTitle: string;
}): Promise<CommitResult> {
  if (!existsSync(input.cwd)) {
    return { committed: false, files: 0, reason: 'the worktree no longer exists' };
  }

  try {
    const git = simpleGit(input.cwd);
    const status = await git.status();

    // The good case: the agent committed as it went, and there is nothing left.
    if (status.files.length === 0) {
      return { committed: false, files: 0, reason: 'nothing left uncommitted' };
    }

    // `add -A` respects .gitignore, which is what keeps build output and the
    // board's own directory out of a card's branch.
    await git.add(['-A']);
    await git.commit(boardCommitMessage(input.cardTitle, input.cardId));

    return { committed: true, files: status.files.length };
  } catch (error) {
    // Never throws into the settle path: a failed commit costs a merge the
    // operator can still perform by hand, while a thrown error would leave the
    // card with no recorded outcome at all.
    return { committed: false, files: 0, reason: (error as Error).message };
  }
}
