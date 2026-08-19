import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';

import { asRecord, numberOr } from '../json.js';
import {
  EXTRACTION_TOOL,
  type ExtractionModel,
  type ExtractionResponse,
  type RawEntry,
} from './model.js';

/**
 * Extraction through the Claude Code CLI (doc 08).
 *
 * The default backend, and the reason is quota rather than convenience: an
 * operator running Claude Code already pays for Claude Code. Requiring a
 * separate `ANTHROPIC_API_KEY` to summarise the sessions they are already paying
 * for is a second bill for the same work, and it makes the ledger - the whole
 * point of the product - opt-in behind a purchase.
 *
 * `claude -p` with `--json-schema` gives the same structured guarantee as the
 * forced tool call in model.ts, and `--output-format json` reports real token
 * usage, so the budget in extract.ts still works.
 *
 * Three flags carry weight:
 *
 * - `--safe-mode` disables hooks. This is not tidiness. Without it every
 *   extraction call fires its own `Stop` hook into the board, which triggers
 *   another extraction, which fires another `Stop` - an unbounded recursion that
 *   would spend the operator's quota until it was gone. `--bare` also skips
 *   hooks but forces `ANTHROPIC_API_KEY`, which defeats the purpose.
 * - `--system-prompt` replaces the coding-agent prompt rather than appending to
 *   it. Extraction is a reading task; the default prompt is several thousand
 *   tokens of instructions about editing files, paid for on every call.
 * - `--tools ""` because extraction needs no tools. A synthesiser that could
 *   edit files is a synthesiser that can be wrong in ways that matter.
 *
 * The working directory is a temporary one, so the board's own project settings
 * are not even discovered. Belt and braces on the recursion, which is the one
 * failure here that costs money rather than a missing summary.
 */

export interface ClaudeCliOptions {
  readonly executable?: string;
  /** Bounded because this runs off the hook path but still holds a chain slot. */
  readonly timeoutMs?: number;
  /** Overridden in tests. Deliberately not the project directory. */
  readonly cwd?: string;
}

export const DEFAULT_CLI_TIMEOUT_MS = 180_000;

/** The result shape of `claude -p --output-format json`, read permissively. */
interface CliResult {
  readonly is_error?: unknown;
  readonly result?: unknown;
  readonly structured_output?: unknown;
  readonly usage?: unknown;
}

/**
 * Everything the request was billed for, as one input figure.
 *
 * Cache creation and cache reads are both real charges, and a budget that
 * counted only fresh input would report a fraction of what a long window costs.
 */
export function usageFromCli(usage: unknown): { inputTokens: number; outputTokens: number } {
  const record = asRecord(usage);

  return {
    inputTokens:
      numberOr(record?.['input_tokens'], 0) +
      numberOr(record?.['cache_creation_input_tokens'], 0) +
      numberOr(record?.['cache_read_input_tokens'], 0),
    outputTokens: numberOr(record?.['output_tokens'], 0),
  };
}

/** Readable whatever the field turns out to hold; never "[object Object]". */
function describe(value: unknown): string {
  if (typeof value === 'string' && value !== '') return value;
  if (value === undefined || value === null) return 'no detail';
  try {
    return JSON.stringify(value) ?? 'no detail';
  } catch {
    return 'no detail';
  }
}

export function parseCliResponse(stdout: string): ExtractionResponse {
  let parsed: CliResult;
  try {
    parsed = JSON.parse(stdout) as CliResult;
  } catch {
    // A non-JSON body is usually the CLI reporting a startup problem in prose.
    throw new Error(`claude did not return JSON: ${stdout.slice(0, 400)}`);
  }

  const usage = usageFromCli(parsed.usage);

  if (parsed.is_error === true) {
    // The CLI's own words. "usage limit reached" is the message the operator
    // most needs to see intact, so it is passed through rather than replaced.
    throw new Error(`claude reported an error: ${describe(parsed.result)}`);
  }

  const entries = asRecord(parsed.structured_output)?.['entries'];

  // An empty list is a legitimate answer for a mechanical turn, so a missing
  // one is treated the same way rather than as a failure.
  return { entries: Array.isArray(entries) ? (entries as RawEntry[]) : [], usage };
}

export function claudeCodeExtractionModel(options: ClaudeCliOptions = {}): ExtractionModel {
  const executable = options.executable ?? 'claude';
  const timeoutMs = options.timeoutMs ?? DEFAULT_CLI_TIMEOUT_MS;
  const cwd = options.cwd ?? tmpdir();

  return async (request) =>
    new Promise<ExtractionResponse>((resolve, reject) => {
      const child = spawn(
        executable,
        [
          '--print',
          '--safe-mode',
          '--no-session-persistence',
          '--tools',
          '',
          '--output-format',
          'json',
          '--model',
          request.model,
          '--system-prompt',
          request.system,
          '--json-schema',
          JSON.stringify(EXTRACTION_TOOL.input_schema),
        ],
        { cwd, stdio: ['pipe', 'pipe', 'pipe'], detached: true },
      );

      let stdout = '';
      let stderr = '';
      let settled = false;

      const finish = (error: Error | null, response?: ExtractionResponse): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error !== null) reject(error);
        else resolve(response as ExtractionResponse);
      };

      const timer = setTimeout(() => {
        // The group, not the child: `claude` has descendants, and killing only
        // the parent leaves them holding the pipe open (learned in launcher.ts).
        try {
          if (child.pid !== undefined) process.kill(-child.pid, 'SIGTERM');
        } catch {
          child.kill('SIGTERM');
        }
        finish(new Error(`claude did not answer within ${String(timeoutMs)}ms`));
      }, timeoutMs);

      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });

      child.on('error', (error: Error) => {
        finish(
          new Error(
            `could not run \`${executable}\`: ${error.message}. Extraction needs the Claude Code CLI on PATH.`,
          ),
        );
      });

      child.on('close', (code) => {
        if (code !== 0 && stdout.trim() === '') {
          finish(
            new Error(
              `claude exited with code ${String(code)}: ${stderr.trim().slice(0, 400) || 'no output'}`,
            ),
          );
          return;
        }

        try {
          finish(null, parseCliResponse(stdout));
        } catch (error) {
          finish(error as Error);
        }
      });

      // The window is written to stdin rather than argv: a PreCompact window can
      // be 80,000 characters, and argument limits are a platform detail.
      //
      // The error handler is load-bearing. If the child exits before reading the
      // prompt - a rejected flag, the wrong binary, an auth failure - this write
      // raises EPIPE, and an unhandled `error` event on a stream takes the entire
      // board process down with it. The `close` handler below reports the real
      // reason; there is nothing to add here but survival.
      child.stdin.on('error', () => {
        /* reported by close, deliberately swallowed here */
      });
      child.stdin.end(request.prompt, 'utf8');
    });
}
