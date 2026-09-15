import { runVerify, type VerifyResult } from '../verify/run.js';

/**
 * Preparing a worktree before the agent is let into it.
 *
 * A git worktree is a clean checkout. It has the repository and none of what
 * the repository needs to run: no `node_modules`, no build, nothing a
 * `postinstall` would have written. Until now every dispatched card met that
 * on arrival, which cost it in two ways - it spent the first of its turns
 * installing dependencies, and when it did not think to, the board's own
 * verify command failed for a reason that had nothing to do with the work. An
 * operator reading that failure sees a card that broke the tests.
 *
 * So the board prepares the workspace itself, from the project's execution
 * policy, before the agent starts. It is the same shape as a verify - one
 * command, run by the board, through a shell - and deliberately reuses that
 * runner rather than growing a second way to execute a string, so a timeout
 * or a missing binary is reported the same way in both places.
 *
 * A failure here stops the dispatch. Handing an agent a workspace that cannot
 * build produces an hour of work against a broken tree and a card that fails
 * for a reason the operator has to go digging for; refusing costs nothing and
 * names the cause.
 */

/** Long enough for a cold `npm ci` on a large project, and bounded. */
export const DEFAULT_PREPARE_TIMEOUT_MS = 15 * 60 * 1000;

export interface PrepareRequest {
  readonly command: string | null;
  readonly cwd: string;
  readonly timeoutMs?: number;
}

export interface PrepareResult {
  /** Whether the dispatch may proceed. A skipped preparation is not a failure. */
  readonly ok: boolean;
  readonly status: VerifyResult['status'];
  readonly command: string;
  readonly output: string;
  readonly durationMs: number;
  readonly exitCode: number | null;
}

/**
 * Bash reserves 127 for a command it could not find, and for a setup command
 * that is a different fix from a setup command that ran and failed: install
 * the tool, rather than repair the project. Worth the one comparison, because
 * "npm: command not found" reported as "setup failed" sends the operator to
 * read a build log that says nothing.
 */
const NOT_FOUND = 127;

export async function prepareWorkspace(request: PrepareRequest): Promise<PrepareResult> {
  const command = request.command?.trim() ?? '';

  if (command === '') {
    return {
      ok: true,
      status: 'skipped',
      command: '',
      output: 'No setup command set for this project.',
      durationMs: 0,
      exitCode: null,
    };
  }

  const result = await runVerify({
    command,
    cwd: request.cwd,
    timeoutMs: request.timeoutMs ?? DEFAULT_PREPARE_TIMEOUT_MS,
  });

  return {
    ok: result.status === 'passed',
    status: result.status,
    command,
    output: result.output,
    durationMs: result.durationMs,
    exitCode: result.exitCode,
  };
}

/**
 * What the operator is told when preparation stops a dispatch.
 *
 * Names the command, says where it ran, and carries the tail of its output.
 * A dispatch failure that says only "setup failed" sends the operator to a
 * terminal to reproduce it, which is the work this is supposed to save.
 */
export function describePrepare(result: PrepareResult, cwd: string): string {
  if (result.ok) {
    return result.status === 'skipped'
      ? 'No setup command set for this project.'
      : `Workspace prepared with \`${result.command}\` (${(result.durationMs / 1000).toFixed(1)}s).`;
  }

  const why =
    result.status === 'errored' || result.exitCode === NOT_FOUND
      ? `The setup command could not run: \`${result.command}\`.`
      : `Setup failed: \`${result.command}\`.`;

  return `${why} It ran in ${cwd}. Fix it there, or change the project's setup command, then dispatch again.\n\n${result.output}`;
}
