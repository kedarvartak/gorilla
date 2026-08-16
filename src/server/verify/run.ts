import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';

const exec = promisify(execFile);

/**
 * Running a card's verify command (doc 18, U1).
 *
 * `verify` was stored, displayed as a hard guardrail, and described to the
 * operator as "run by the board itself, so it does not depend on the agent
 * reporting honestly" - and nothing ran it. It was folded into the goal
 * condition and left to an evaluator that cannot execute commands.
 *
 * That is the exact failure R10 exists to prevent, committed inside the code
 * that prevents it, and made worse by the interface asserting the enforcement
 * in as many words. This module is what makes the claim true.
 */

export interface VerifyRequest {
  readonly command: string;
  /** The card's worktree, or the board directory when it has none. */
  readonly cwd: string;
  readonly timeoutMs?: number;
}

export type VerifyStatus = 'passed' | 'failed' | 'errored' | 'skipped';

export interface VerifyResult {
  readonly status: VerifyStatus;
  readonly command: string;
  readonly exitCode: number | null;
  /** Tail of combined output. Enough to see a failure, not the whole suite. */
  readonly output: string;
  readonly durationMs: number;
  readonly cwd: string;
}

export const DEFAULT_VERIFY_TIMEOUT_MS = 10 * 60 * 1000;
const OUTPUT_TAIL = 4_000;

function tail(text: string): string {
  return text.length <= OUTPUT_TAIL ? text : `…${text.slice(-OUTPUT_TAIL)}`;
}

/**
 * Runs the command through a shell, because a verify command is written the way
 * the operator would type it - pipes, `&&`, quotes and all.
 *
 * Never throws. A verify that crashes the board would take down the thing that
 * was supposed to be checking, and `errored` is distinct from `failed` so the
 * operator can tell "the tests failed" from "the command could not run".
 */
export async function runVerify(request: VerifyRequest): Promise<VerifyResult> {
  const command = request.command.trim();
  const startedAt = Date.now();

  const base = {
    command,
    cwd: request.cwd,
    durationMs: 0,
  };

  if (command === '') {
    return { ...base, status: 'skipped', exitCode: null, output: 'No verify command set.' };
  }

  if (!existsSync(request.cwd)) {
    return {
      ...base,
      status: 'errored',
      exitCode: null,
      output: `Working directory does not exist: ${request.cwd}`,
    };
  }

  try {
    const { stdout, stderr } = await exec(command, {
      cwd: request.cwd,
      shell: '/bin/bash',
      timeout: request.timeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, CI: 'true' },
    });

    return {
      ...base,
      status: 'passed',
      exitCode: 0,
      output: tail(`${stdout}${stderr}`),
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & {
      code?: number | string;
      stdout?: string;
      stderr?: string;
      killed?: boolean;
    };

    const output = tail(`${failure.stdout ?? ''}${failure.stderr ?? ''}` || failure.message);
    const exitCode = typeof failure.code === 'number' ? failure.code : null;

    // A non-zero exit is the command doing its job. Anything else - a missing
    // binary, a timeout - is the check itself being broken, which the operator
    // must not read as "the tests failed".
    const status: VerifyStatus = exitCode !== null ? 'failed' : 'errored';

    return {
      ...base,
      status,
      exitCode,
      output:
        failure.killed === true
          ? `${output}\n\n[verify timed out after ${request.timeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS}ms]`
          : output,
      durationMs: Date.now() - startedAt,
    };
  }
}

export function describeVerify(result: VerifyResult): string {
  switch (result.status) {
    case 'passed':
      return `Verify passed: \`${result.command}\` (${(result.durationMs / 1000).toFixed(1)}s)`;
    case 'failed':
      return `Verify FAILED: \`${result.command}\` exited ${String(result.exitCode)}`;
    case 'errored':
      return `Verify could not run: \`${result.command}\``;
    case 'skipped':
      return 'No verify command set for this card.';
  }
}
