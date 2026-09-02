import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Asking an agent whether a card is already done (issue 173).
 *
 * The previous resync answered this with git alone: it took the files a card
 * named and looked for one commit that touched all of them. That rule is cheap
 * enough to run on a button press and it is honest about what it knows, but it
 * can only ever see the shape of a change, never its meaning. It cannot tell a
 * card that asked for a rewrite from one that asked for a rename, it is blind
 * to any card that names no file, and it has nothing to say about the twelve
 * abandoned cards that are the actual reason an operator wants this - work that
 * was done in another window, under another harness, against no card at all.
 *
 * So the question goes to something that can read. A cheap model, in a
 * read-only sandbox, with the repository in front of it and the cards
 * described to it, answering in a fixed schema.
 *
 * Three things make that affordable and safe:
 *
 * - **One call for the whole sweep.** Measured against this repository: one
 *   card cost 87k input tokens and 42 seconds, two cost 186k. So the cost is
 *   mostly per-card and batching is not free - but a sweep shares the agent's
 *   orientation and its prompt cache across the column, and ten separate calls
 *   would pay for both ten times. It is also the only shape in which the agent
 *   can notice that two cards describe the same work.
 * - **`--sandbox read-only`.** The agent runs in the operator's actual
 *   repository - it has to, that is the question - so it is the sandbox and
 *   not our good manners that stops it writing there.
 * - **`--output-schema`.** The verdict is parsed, not read. A model that
 *   answers in prose is a model whose answer we would have to interpret, and
 *   interpreting it is the job we are trying to hand over.
 */

/** What the board tells the agent about one card. */
export interface ResyncSubject {
  readonly cardId: string;
  readonly title: string;
  readonly body: string;
  readonly goalCondition: string | null;
  /** Concrete files the card names, if any. Evidence, not instruction. */
  readonly paths: readonly string[];
  readonly status: string;
  /** When the card was written, so "since" means something. */
  readonly createdAt: number;
  /** Whether this board has ever dispatched it. */
  readonly hasRun: boolean;
}

/**
 * Where the agent says a card belongs.
 *
 * Three states and not two, because "not done" and "somebody did something
 * here" are different answers and collapsing them would either move work that
 * is half-finished into Done or leave work that is plainly finished sitting in
 * Ready for ever.
 */
export type ResyncState = 'done' | 'review' | 'unfinished';

export interface ResyncVerdict {
  readonly cardId: string;
  readonly state: ResyncState;
  /** Why, in the agent's own words. Shown to the operator verbatim. */
  readonly evidence: string;
  /** Commits it is pointing at, when it found any. */
  readonly commits: readonly string[];
}

/** What one sweep cost, so the board can say so rather than guess. */
export interface ResyncUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface ResyncJudgement {
  readonly verdicts: readonly ResyncVerdict[];
  readonly usage: ResyncUsage | null;
  /** The model that answered, for the report. */
  readonly model: string | null;
}

/**
 * The judge, as a function the board can be handed.
 *
 * The same shape as the extraction model and the second-opinion reviewer, and
 * for the same reason: every test in this repository substitutes its own, so
 * the suite never spends a token and never depends on a CLI being installed.
 */
export type ResyncJudge = (request: {
  readonly repoCwd: string;
  readonly cards: readonly ResyncSubject[];
}) => Promise<ResyncJudgement>;

/**
 * The default model.
 *
 * Not the board's, and deliberately down a tier. This is a reading task with a
 * three-way answer, run over a whole column at once and repeated whenever an
 * operator returns to a board they have been away from - the cheapest thing
 * that can read a diff and hold a judgement is the right instrument.
 */
export const DEFAULT_RESYNC_MODEL = 'gpt-5.4';

/**
 * The model this board will actually use.
 *
 * `GORILLA_RESYNC_MODEL` overrides it, following `GORILLA_EXTRACTION` next
 * door. An operator whose account offers a different set of models than the
 * machine this was written on should not have to edit the source to use one,
 * and the cheapest model available is a per-account fact rather than a
 * per-repository one.
 */
export function resolveResyncModel(env: NodeJS.ProcessEnv = process.env): string {
  const named = (env['GORILLA_RESYNC_MODEL'] ?? '').trim();
  return named === '' ? DEFAULT_RESYNC_MODEL : named;
}

/** Long, because the agent is reading a repository and not a paragraph. */
export const DEFAULT_TIMEOUT_MS = 300_000;

/**
 * The answer's shape.
 *
 * Strict: every property required and `additionalProperties: false` throughout,
 * because a schema that tolerates extra keys is a schema that will eventually
 * receive a `state` the board does not know how to act on.
 */
export const RESYNC_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdicts'],
  properties: {
    verdicts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['cardId', 'state', 'evidence', 'commits'],
        properties: {
          cardId: { type: 'string' },
          state: { type: 'string', enum: ['done', 'review', 'unfinished'] },
          evidence: { type: 'string' },
          commits: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
} as const;

const INSTRUCTIONS = [
  'You are auditing a kanban board against the repository it belongs to.',
  '',
  'Each card below describes work somebody intended. Your job is to decide, for',
  'each one, whether that work is already in this repository - done in another',
  'window, under another harness, or by hand, without the board ever hearing',
  'about it. Read the code and the history. Do not take a card at its word.',
  '',
  'Answer with one verdict per card:',
  '',
  '  done       The work this card describes is present and complete. You have',
  '             read the code that does it, not just a file with the right name.',
  '  review     Something here was done, but it is partial, or it differs from',
  '             what the card asked for, or you cannot tell without a person.',
  '  unfinished No trace of it. This is the right answer whenever you are unsure',
  '             there is anything at all.',
  '',
  'Rules that matter:',
  '',
  '- A file existing is not the work being done. A card asking for a change',
  '  inside a file that already existed will trip that test on the day it was',
  '  written. Open the file and check for the change itself.',
  '- Only count work that landed after the card was written. Anything older is',
  '  what the card was written against, not evidence that it was carried out.',
  '- "done" moves the card to the board\'s terminal column and stops anyone',
  '  looking at it again. Say it only about work you have actually read.',
  '- Cite what you found. `evidence` is shown to the operator verbatim, so',
  '  write the sentence you would want to read: what you looked at, and what',
  '  was or was not in it. Put commit hashes in `commits` when you have them.',
  '- Answer for every card you are given, including the ones you find nothing',
  '  for. A card missing from your answer is left where it is.',
].join('\n');

/** One card, as the agent sees it. */
function describe(card: ResyncSubject, index: number): string {
  const lines = [
    `### Card ${String(index + 1)}`,
    `cardId: ${card.cardId}`,
    `title: ${card.title}`,
    `status: ${card.status}`,
    `written: ${new Date(card.createdAt).toISOString()}`,
    `dispatched by this board: ${card.hasRun ? 'yes' : 'never'}`,
  ];

  if (card.goalCondition !== null && card.goalCondition.trim() !== '') {
    lines.push(`goal: ${card.goalCondition.trim()}`);
  }
  if (card.paths.length > 0) {
    // Named as a hint and not as the answer: the previous resync treated this
    // list as the whole of the evidence and was wrong for it.
    lines.push(`files it names (a hint, not the test): ${card.paths.join(', ')}`);
  }
  if (card.body.trim() !== '') {
    lines.push('', card.body.trim());
  }

  return lines.join('\n');
}

export function buildPrompt(cards: readonly ResyncSubject[]): string {
  return [INSTRUCTIONS, '', '## The cards', '', ...cards.map(describe)].join('\n\n');
}

/** The verdicts, keeping only what the board knows how to act on. */
export function parseVerdicts(raw: unknown, known: ReadonlySet<string>): ResyncVerdict[] {
  const record = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : null;
  const list = record?.['verdicts'];
  if (!Array.isArray(list)) return [];

  const verdicts: ResyncVerdict[] = [];
  const seen = new Set<string>();

  for (const item of list) {
    if (typeof item !== 'object' || item === null) continue;
    const entry = item as Record<string, unknown>;

    const cardId = entry['cardId'];
    const state = entry['state'];
    const evidence = entry['evidence'];

    // A verdict about a card we did not ask about is not a card we may move.
    // The set is the board's, so a hallucinated id cannot reach the database.
    if (typeof cardId !== 'string' || !known.has(cardId) || seen.has(cardId)) continue;
    if (state !== 'done' && state !== 'review' && state !== 'unfinished') continue;
    if (typeof evidence !== 'string' || evidence.trim() === '') continue;

    seen.add(cardId);
    verdicts.push({
      cardId,
      state,
      evidence: evidence.trim(),
      commits: Array.isArray(entry['commits'])
        ? entry['commits'].filter((hash): hash is string => typeof hash === 'string')
        : [],
    });
  }

  return verdicts;
}

/** The usage `codex exec --json` reports on its last event. */
export function parseUsage(stdout: string): ResyncUsage | null {
  let usage: ResyncUsage | null = null;

  for (const line of stdout.split('\n')) {
    if (line.trim() === '') continue;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }

    const record = event as Record<string, unknown>;
    if (record['type'] !== 'turn.completed') continue;

    const reported = record['usage'];
    if (typeof reported !== 'object' || reported === null) continue;
    const counts = reported as Record<string, unknown>;

    // Cached input is input the operator still paid something for, and reading
    // a repository is mostly cache hits. Counting only the uncached half would
    // report a sweep as costing a fifth of what it did.
    const input = Number(counts['input_tokens'] ?? 0);
    const output = Number(counts['output_tokens'] ?? 0);

    usage = {
      inputTokens: Number.isFinite(input) ? input : 0,
      outputTokens: Number.isFinite(output) ? output : 0,
    };
  }

  return usage;
}

export interface JudgeOptions {
  readonly executable?: string;
  readonly model?: string;
  readonly timeoutMs?: number;
}

/**
 * The judge, run through the Codex CLI on the operator's own quota.
 *
 * In the repository rather than a temporary directory, which is the one place
 * every other model call in this codebase refuses to run. Those are summarising
 * a transcript and have no business near the working tree; this one is being
 * asked what is in the working tree, and cannot answer from anywhere else.
 * `--sandbox read-only` is what makes that safe, and it is the flag to check
 * first if this is ever changed.
 */
export function codexResyncJudge(options: JudgeOptions = {}): ResyncJudge {
  const executable = options.executable ?? 'codex';
  const model = options.model ?? DEFAULT_RESYNC_MODEL;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return async ({ repoCwd, cards }) => {
    if (cards.length === 0) return { verdicts: [], usage: null, model };

    const dir = mkdtempSync(join(tmpdir(), 'gorilla-resync-'));
    const schemaPath = join(dir, 'schema.json');
    const answerPath = join(dir, 'answer.json');
    writeFileSync(schemaPath, JSON.stringify(RESYNC_SCHEMA), 'utf8');

    const known = new Set(cards.map((card) => card.cardId));

    try {
      return await new Promise<ResyncJudgement>((resolve, reject) => {
        const child = spawn(
          executable,
          [
            'exec',
            '--json',
            // The whole safety argument. Everything else here is convenience.
            '--sandbox',
            'read-only',
            '--model',
            model,
            // No session file for a call nobody will ever resume.
            '--ephemeral',
            '--output-schema',
            schemaPath,
            '--output-last-message',
            answerPath,
            '--cd',
            repoCwd,
            buildPrompt([...cards]),
          ],
          // stdin closed, not piped: given a pipe it stops to read from it and
          // the sweep hangs until the timeout with nothing to show for it.
          { cwd: repoCwd, stdio: ['ignore', 'pipe', 'pipe'], detached: true },
        );

        let stdout = '';
        let stderr = '';
        let settled = false;

        const finish = (error: Error | null, judgement?: ResyncJudgement): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (error !== null) reject(error);
          else resolve(judgement ?? { verdicts: [], usage: null, model });
        };

        const timer = setTimeout(() => {
          // The group, not the child: `codex` runs the commands it decides on
          // as its own children, and killing only the parent leaves them.
          try {
            if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
          } catch {
            child.kill('SIGKILL');
          }
          finish(new Error(`The resync agent did not answer within ${String(timeoutMs)}ms.`));
        }, timeoutMs);

        child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
        child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
        child.on('error', (error) => finish(error));

        child.on('close', (code) => {
          let answer: string;
          try {
            answer = readFileSync(answerPath, 'utf8');
          } catch {
            // Its own words first. "not logged in" and "usage limit reached"
            // are the two an operator most needs to read intact.
            const said = (stderr || stdout).trim().slice(-300);
            finish(
              new Error(
                said === ''
                  ? `The resync agent exited ${String(code)} without answering.`
                  : `The resync agent did not answer: ${said}`,
              ),
            );
            return;
          }

          try {
            finish(null, {
              verdicts: parseVerdicts(JSON.parse(answer), known),
              usage: parseUsage(stdout),
              model,
            });
          } catch {
            finish(new Error(`The resync agent did not return JSON: ${answer.slice(0, 300)}`));
          }
        });
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}
