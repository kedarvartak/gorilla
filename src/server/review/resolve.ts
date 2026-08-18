import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { simpleGit, type SimpleGit } from 'simple-git';

import { runVerify, type VerifyResult } from '../verify/run.js';

/**
 * Resolving a merge conflict, rather than reporting one (doc 18).
 *
 * `mergeBranches` stops at a conflict and leaves it in the working tree, which
 * is right - aborting destroys the evidence - but stopping there makes the
 * board's one merge action fail on exactly the mornings it is most needed. Two
 * cards touching one file is not an exceptional event when several agents work
 * overnight; it is the ordinary cost of parallelism.
 *
 * So the conflict becomes work the board does. This is the reviewer agent from
 * doc 18 narrowed to one job: take a repository that is mid-merge, make the
 * conflicted files coherent, keep both sides' intent, prove it with the
 * project's own verify command, and commit the merge.
 *
 * Deliberately narrow, because a resolver with a wide remit is a second author.
 * It may not abort the merge, reset, rebase, push, or touch a file that is not
 * conflicted, and the verify it must pass is the operator's rather than one it
 * chooses. If it cannot succeed, the conflict is still sitting in the tree
 * exactly as it was - which is where this started, and no worse.
 */

export type ResolveOutcome =
  'resolved' | 'still-conflicted' | 'verify-failed' | 'not-merging' | 'errored';

export interface ResolveResult {
  readonly outcome: ResolveOutcome;
  readonly detail: string;
  readonly files: readonly string[];
  readonly verify?: VerifyResult;
}

/** Files git currently reports as conflicted. */
export async function conflictedFiles(git: SimpleGit): Promise<string[]> {
  const status = await git.status();
  return [...status.conflicted];
}

/** Whether the repository is part way through a merge. */
export function isMerging(repoCwd: string): boolean {
  return existsSync(join(repoCwd, '.git', 'MERGE_HEAD'));
}

export function resolvePrompt(input: {
  branch: string;
  into: string;
  files: readonly string[];
  verifyCommand: string | null;
}): string {
  return [
    `This git repository is part way through merging \`${input.branch}\` into \`${input.into}\`.`,
    '',
    'Conflicted files:',
    ...input.files.map((file) => `- ${file}`),
    '',
    'Resolve every conflict so the result keeps the intent of both sides. The two',
    'sides are usually one file changed by two agents working in parallel, so the',
    'answer is rarely "take one side": keep both changes unless they genuinely',
    'contradict, and where they do, keep the one the surrounding code and tests',
    'require.',
    '',
    'Rules:',
    '- Do not run `git merge --abort`, `git reset`, `git rebase`, or `git push`.',
    '- Do not change files that are not in the conflicted list.',
    '- Remove every conflict marker. Leaving one is a failure, not a partial success.',
    input.verifyCommand === null
      ? '- Then stage the resolved files and commit the merge.'
      : `- Then stage the resolved files, commit the merge, and run \`${input.verifyCommand}\`.`,
    '',
    'Report in one line what you kept from each side, and stop.',
  ].join('\n');
}

export interface ResolveRequest {
  readonly repoCwd: string;
  readonly branch: string;
  readonly into: string;
  readonly verifyCommand?: string | null;
  readonly model?: string;
  readonly timeoutMs?: number;
  /** Overridable for tests, which must never spawn a real agent. */
  readonly executable?: string;
}

export const DEFAULT_RESOLVE_TIMEOUT_MS = 15 * 60 * 1000;

/** Runs the resolver and waits. Its own report is not trusted; git is asked after. */
async function runResolver(
  request: ResolveRequest,
  prompt: string,
): Promise<{ ok: boolean; detail: string }> {
  return new Promise((resolve) => {
    const child = spawn(
      request.executable ?? 'claude',
      [
        '--print',
        // It edits files and runs the verify command. Anything less permissive
        // is the wall this exists to remove.
        '--permission-mode',
        'bypassPermissions',
        '--model',
        request.model ?? 'sonnet',
        '--output-format',
        'json',
      ],
      // Its own process group, so a timeout takes the whole tree with it.
      { cwd: request.repoCwd, stdio: ['pipe', 'pipe', 'pipe'], detached: true },
    );

    let stderr = '';
    let settled = false;

    const finish = (ok: boolean, detail: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok, detail });
    };

    const timer = setTimeout(() => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, 'SIGTERM');
      } catch {
        child.kill('SIGTERM');
      }
      finish(false, 'The resolver did not finish in time.');
    }, request.timeoutMs ?? DEFAULT_RESOLVE_TIMEOUT_MS);

    child.stdout.on('data', () => undefined);
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });

    child.on('error', (error: Error) =>
      finish(false, `Could not run the resolver: ${error.message}`),
    );
    child.on('close', (code) =>
      finish(code === 0, code === 0 ? 'The resolver finished.' : stderr.trim().slice(0, 400)),
    );

    // An unhandled EPIPE here would take the board down with it.
    child.stdin.on('error', () => undefined);
    child.stdin.end(prompt, 'utf8');
  });
}

/**
 * Resolves the conflict the board is currently sitting in.
 *
 * Judged by the repository, never by what the resolver says about itself: the
 * conflict is gone only when git reports no conflicted files and no merge in
 * progress, and the result is sound only when the operator's own verify passes.
 */
export async function resolveConflicts(request: ResolveRequest): Promise<ResolveResult> {
  if (!existsSync(request.repoCwd)) {
    return { outcome: 'errored', detail: 'The repository directory does not exist.', files: [] };
  }

  if (!isMerging(request.repoCwd)) {
    return {
      outcome: 'not-merging',
      detail: 'This repository is not part way through a merge, so there is nothing to resolve.',
      files: [],
    };
  }

  const git = simpleGit(request.repoCwd);
  const files = await conflictedFiles(git);

  const prompt = resolvePrompt({
    branch: request.branch,
    into: request.into,
    files,
    verifyCommand: request.verifyCommand ?? null,
  });

  const run = await runResolver(request, prompt);

  const remaining = await conflictedFiles(git);
  if (remaining.length > 0 || isMerging(request.repoCwd)) {
    return {
      outcome: 'still-conflicted',
      detail:
        remaining.length > 0
          ? `${String(remaining.length)} file(s) are still conflicted. ${run.detail}`
          : `The conflicts were resolved but the merge was never committed. ${run.detail}`,
      files: remaining.length > 0 ? remaining : files,
    };
  }

  if (request.verifyCommand === null || request.verifyCommand === undefined) {
    return { outcome: 'resolved', detail: 'Conflicts resolved and the merge committed.', files };
  }

  // Run it here rather than trusting that it was run. The board owning verify
  // is precisely what stops any of this depending on honest reporting.
  const verify = await runVerify({ command: request.verifyCommand, cwd: request.repoCwd });

  if (verify.status === 'passed' || verify.status === 'skipped') {
    return {
      outcome: 'resolved',
      detail: 'Conflicts resolved, merge committed, and the project still passes.',
      files,
      verify,
    };
  }

  return {
    outcome: 'verify-failed',
    detail:
      'The conflicts were resolved and committed, but the project no longer passes. ' +
      'The merge commit is in place so the resolution can be inspected or reverted.',
    files,
    verify,
  };
}
