import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';

import { simpleGit } from 'simple-git';

const execFileAsync = promisify(execFile);

export class PullRequestError extends Error {}

export interface OpenPullRequestRequest {
  readonly repoCwd: string;
  readonly source: string;
  readonly base: string;
  readonly title: string;
  readonly body: string;
}

export interface PullRequest {
  readonly url: string;
  readonly source: string;
  readonly base: string;
}

/**
 * Publishes a finished card without changing the operator's checkout.
 *
 * `git push` and `gh` receive argument arrays, never a shell command: card
 * titles and branch choices are user-provided and must remain data, not code.
 */
export async function openPullRequest(request: OpenPullRequestRequest): Promise<PullRequest> {
  if (!existsSync(request.repoCwd)) {
    throw new PullRequestError(`The repository directory does not exist: ${request.repoCwd}`);
  }

  const git = simpleGit(request.repoCwd);
  try {
    await git.push('origin', request.source, ['--set-upstream']);
  } catch (cause) {
    throw new PullRequestError(
      `Could not push ${request.source} to origin: ${(cause as Error).message}`,
    );
  }

  try {
    const { stdout } = await execFileAsync(
      'gh',
      [
        'pr',
        'create',
        '--base',
        request.base,
        '--head',
        request.source,
        '--title',
        request.title,
        '--body',
        request.body,
      ],
      { cwd: request.repoCwd },
    );
    const url = stdout.match(/https:\/\/github\.com\/[^\s]+\/pull\/\d+/)?.[0];
    if (url === undefined) {
      throw new PullRequestError('GitHub did not return the URL of the pull request it created.');
    }
    return { url, source: request.source, base: request.base };
  } catch (cause) {
    if (cause instanceof PullRequestError) throw cause;
    throw new PullRequestError(`Could not open the pull request: ${(cause as Error).message}`);
  }
}
