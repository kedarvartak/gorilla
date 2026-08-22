import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';

import { asRecord } from '../json.js';

/**
 * A fresh reading of the branch, before the gate opens (T36).
 *
 * Everything the board knows about a run comes from that run. The ledger is
 * synthesised from its own events, the verify is a command the card chose, and
 * the diff is what the agent decided to write. Nothing has ever looked at the
 * work without having produced it.
 *
 * So this asks a session that has no history with the card to read the diff
 * and say what worries it. The findings are claims, not verdicts: they enter
 * the ledger unreviewed, which makes them surprises the merge gate already
 * holds on, and the operator judges them exactly as they judge anything else
 * the model asserts.
 *
 * On demand, never automatic. It costs a model call per card, and a reviewer
 * that ran on every completion would double the spend of an overnight batch
 * without anybody having asked it to.
 */

export const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['risk', 'question'] },
          statement: { type: 'string' },
          filePath: { type: 'string' },
        },
        required: ['kind', 'statement'],
      },
    },
  },
  required: ['findings'],
} as const;

/**
 * Risk and question only.
 *
 * A reviewer that could emit a decision would be recording a choice it did not
 * make, and one that could emit a change would be restating the diff it was
 * handed. Both are things the ledger already gets from the run itself.
 */
export type FindingKind = 'risk' | 'question';

export interface Finding {
  readonly kind: FindingKind;
  readonly statement: string;
  readonly filePath: string | null;
}

/**
 * A bound on what is sent.
 *
 * A diff larger than this is truncated and the prompt says so. Reviewing a
 * third of a change while reporting on all of it is worse than declining: the
 * operator would read "nothing worrying" about code nobody looked at.
 */
export const MAX_DIFF_CHARS = 60_000;

export interface ReviewRequest {
  readonly cardTitle: string;
  readonly goal: string | null;
  readonly diff: string;
}

export const SYSTEM = [
  'You are reviewing a branch you did not write, for someone who has to decide whether to merge it.',
  'You have the diff and nothing else. Do not guess at what the rest of the codebase does.',
  '',
  'Report only what would change a decision: something that looks wrong, something that',
  'contradicts what the card asked for, or a question whose answer decides whether this is safe.',
  '',
  'Do not restate what the diff does. Whoever reads this has the diff.',
  'Do not report style, naming or formatting.',
  'An empty list is the right answer for a change with nothing worrying in it, and is expected often.',
].join('\n');

export function buildPrompt(request: ReviewRequest): string {
  const truncated = request.diff.length > MAX_DIFF_CHARS;
  const diff = truncated ? request.diff.slice(0, MAX_DIFF_CHARS) : request.diff;

  return [
    `Card: ${request.cardTitle}`,
    request.goal === null ? '' : `It is done when: ${request.goal}`,
    '',
    truncated
      ? `The diff is ${String(request.diff.length)} characters and has been cut to ${String(MAX_DIFF_CHARS)}. Say so in a question if that matters to your reading.`
      : '',
    '',
    'Diff:',
    diff,
  ]
    .filter((line) => line !== '')
    .join('\n');
}

export function parseFindings(structured: unknown): Finding[] {
  const raw = asRecord(structured)?.['findings'];
  if (!Array.isArray(raw)) return [];

  const findings: Finding[] = [];

  for (const item of raw) {
    const record = asRecord(item);
    const statement = record?.['statement'];
    const kind = record?.['kind'];

    if (typeof statement !== 'string' || statement.trim() === '') continue;
    if (kind !== 'risk' && kind !== 'question') continue;

    findings.push({
      kind,
      statement: statement.trim(),
      filePath: typeof record?.['filePath'] === 'string' ? record['filePath'] : null,
    });
  }

  return findings;
}

export interface RunnerOptions {
  readonly executable?: string;
  readonly timeoutMs?: number;
  readonly model?: string;
}

export type ReviewRunner = (request: ReviewRequest) => Promise<Finding[]>;

export const DEFAULT_TIMEOUT_MS = 180_000;

/**
 * Runs the review through the Claude Code CLI, on the operator's own quota.
 *
 * The same three flags the extraction path explains at length, for the same
 * reasons. `--safe-mode` most of all: without it this call fires its own hooks
 * into the board, and a review that triggers a review is an unbounded spend.
 */
export function claudeCodeReviewer(options: RunnerOptions = {}): ReviewRunner {
  const executable = options.executable ?? 'claude';
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return async (request) =>
    new Promise<Finding[]>((resolve, reject) => {
      const child = spawn(
        executable,
        [
          '--print',
          '--safe-mode',
          '--no-session-persistence',
          // No tools. A reviewer that could edit files is a reviewer that can
          // be wrong in a way that costs more than a bad review.
          '--tools',
          '',
          '--output-format',
          'json',
          ...(options.model === undefined ? [] : ['--model', options.model]),
          '--system-prompt',
          SYSTEM,
          '--json-schema',
          JSON.stringify(REVIEW_SCHEMA),
        ],
        // A temporary directory, so the project's own settings are not even
        // discovered. Belt and braces on the recursion.
        { cwd: tmpdir(), stdio: ['pipe', 'pipe', 'pipe'], detached: true },
      );

      let stdout = '';
      let stderr = '';
      let settled = false;

      const finish = (error: Error | null, findings?: Finding[]): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error !== null) reject(error);
        else resolve(findings ?? []);
      };

      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        finish(new Error(`The reviewer did not answer within ${String(timeoutMs)}ms.`));
      }, timeoutMs);

      child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
      child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
      child.on('error', (error) => finish(error));

      child.on('close', () => {
        try {
          const parsed = JSON.parse(stdout) as {
            is_error?: unknown;
            result?: unknown;
            structured_output?: unknown;
          };

          if (parsed.is_error === true) {
            // The CLI's own words. "usage limit reached" is the one the
            // operator most needs to see intact.
            finish(new Error(`The reviewer reported an error: ${String(parsed.result)}`));
            return;
          }

          finish(null, parseFindings(parsed.structured_output));
        } catch {
          finish(
            new Error(`The reviewer did not return JSON: ${(stdout || stderr).slice(0, 300)}`),
          );
        }
      });

      child.stdin.end(buildPrompt(request));
    });
}
