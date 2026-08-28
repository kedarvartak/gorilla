import { existsSync, readFileSync, statSync } from 'node:fs';

import { asc, eq } from 'drizzle-orm';

import type { DatabaseHandle } from '../db/client.js';
import { runs } from '../db/schema.js';
import { parseLine } from './records.js';

/**
 * What the agent was thinking, saying and doing, for the operator to read.
 *
 * The board could say a card was running and nothing else. Counts, a line per
 * hook event, and a ledger afterwards - none of which is what a person watching
 * a terminal is actually watching. An agent left running unattended is exactly
 * when the reasoning matters most, and it was the one moment the board had
 * nothing to show.
 *
 * None of this is newly captured. Claude's transcript already parses `thinking`
 * and `text` into separate fields, and `reader.ts` already joins them - only to
 * build the window handed to the extraction model, after which they were
 * dropped. Codex's stream events have been written to the `events` table as
 * `CodexEvent` rows since the provider was added. Both were being collected,
 * read once by a model, and never shown to the person the board is for.
 */

export type NarrationKind = 'thinking' | 'said' | 'did' | 'asked';

export interface NarrationEntry {
  readonly runId: string;
  /** Position within the whole card, so the client can ask for what is new. */
  readonly seq: number;
  readonly at: number | null;
  readonly kind: NarrationKind;
  readonly text: string;
  /** The tool, when the entry is something the agent did. */
  readonly tool: string | null;
}

export interface Narration {
  readonly entries: readonly NarrationEntry[];
  /** Everything there is, so the client can say what it is not showing. */
  readonly total: number;
  readonly provider: 'claude' | 'codex' | 'mixed' | null;
  /** Times the model thought and the harness kept none of the words. */
  readonly withheldThinking: number;
  /**
   * What this provider did not give, in words.
   *
   * A gap the operator cannot account for reads as the agent having gone quiet,
   * which is the opposite of what this screen is for.
   */
  readonly note: string | null;
}

const EMPTY: Narration = {
  entries: [],
  total: 0,
  provider: null,
  withheldThinking: 0,
  note: null,
};

/**
 * A tool call in one line.
 *
 * The argument that says what the call was for, rather than the whole object.
 * `Bash` tells an operator an agent ran something; `Bash npm test` tells them
 * what it did, and that is the difference between a log and an account.
 */
function summarise(input: Record<string, unknown> | null): string {
  if (input === null) return '';

  for (const key of ['command', 'file_path', 'path', 'pattern', 'query', 'url', 'prompt']) {
    const value = input[key];
    if (typeof value === 'string' && value.trim() !== '') return value;
  }

  const first = Object.values(input).find((value) => typeof value === 'string' && value !== '');
  return typeof first === 'string' ? first : '';
}

/* -------------------------------------------------------------------------- */
/* Claude                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Reparsed only when the file has changed.
 *
 * This is polled while a card runs, and a transcript is append-only, so the
 * overwhelmingly common poll is one where nothing has moved. Keyed on size and
 * mtime together because either alone can miss an edit.
 */
const cache = new Map<string, { size: number; mtimeMs: number; parsed: Parsed }>();

interface Parsed {
  readonly entries: NarrationEntry[];
  readonly withheld: number;
}

function fromTranscript(path: string, runId: string): Parsed {
  const nothing: Parsed = { entries: [], withheld: 0 };
  if (!existsSync(path)) return nothing;

  let stamp: { size: number; mtimeMs: number };
  try {
    const stats = statSync(path);
    stamp = { size: stats.size, mtimeMs: stats.mtimeMs };
  } catch {
    return nothing;
  }

  const cached = cache.get(path);
  if (cached !== undefined && cached.size === stamp.size && cached.mtimeMs === stamp.mtimeMs) {
    return cached.parsed;
  }

  const entries: NarrationEntry[] = [];
  let withheld = 0;
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return nothing;
  }

  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    const record = parseLine(line);
    if (record === null) continue;

    const at =
      record.kind === 'assistant' || record.kind === 'user' ? toMillis(record.timestamp) : null;

    if (record.kind === 'assistant') {
      // Thinking first: it is what produced the sentence that follows it, and
      // reading them the other way round is reading the conclusion first.
      if (record.thinking !== '') push(entries, runId, at, 'thinking', record.thinking, null);
      withheld += record.redactedThinking;
      if (record.text !== '') push(entries, runId, at, 'said', record.text, null);
      for (const tool of record.tools) {
        push(entries, runId, at, 'did', summarise(tool.input), tool.name);
      }
      continue;
    }

    // A tool result arrives as a user record whose content holds no text
    // block, so `parseContent` leaves it empty. Skipping those is what keeps
    // this a narration rather than a dump of every byte the tools returned.
    if (record.kind === 'user' && record.text !== '') {
      push(entries, runId, at, 'asked', record.text, null);
    }
  }

  const parsed: Parsed = { entries, withheld };
  cache.set(path, { ...stamp, parsed });
  return parsed;
}

function toMillis(timestamp: string | null): number | null {
  if (timestamp === null) return null;
  const at = Date.parse(timestamp);
  return Number.isNaN(at) ? null : at;
}

/* -------------------------------------------------------------------------- */
/* Codex                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Peels the envelope off a Codex event.
 *
 * Codex writes its recorded sessions as `{timestamp, type, payload}` and its
 * `--json` stream in shapes that have moved between releases - `{msg}` and
 * `{item}` both appear in the wild. The board stores whatever arrived, so this
 * unwraps whichever of them it is given and classifies on the inner `type`.
 *
 * Deliberately tolerant rather than pinned to one schema: this repository has
 * no fixture for what `codex exec --json` emits, the CLI documents `--json`
 * only as "Print events to stdout as JSONL", and a mapper written against a
 * guess would fail silently on the version the operator happens to have.
 */
function unwrap(payload: unknown): Record<string, unknown> | null {
  let current = payload;

  for (let depth = 0; depth < 3; depth += 1) {
    if (typeof current !== 'object' || current === null) return null;
    const record = current as Record<string, unknown>;

    for (const key of ['payload', 'msg', 'item'] as const) {
      const inner = record[key];
      if (typeof inner === 'object' && inner !== null) {
        current = inner;
        break;
      }
      if (key === 'item') return record;
    }
  }

  return typeof current === 'object' && current !== null
    ? (current as Record<string, unknown>)
    : null;
}

/** The first readable text in a value Codex uses for prose. */
function textOf(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';

  return value
    .map((part) => {
      if (typeof part === 'string') return part;
      if (typeof part !== 'object' || part === null) return '';
      const text = (part as Record<string, unknown>)['text'];
      return typeof text === 'string' ? text : '';
    })
    .filter((part) => part !== '')
    .join('\n');
}

function readString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === 'string' ? value : '';
}

function fromCodexEvent(
  payload: unknown,
  runId: string,
  seqAt: number | null,
): Omit<NarrationEntry, 'seq'> | null {
  const body = unwrap(payload);
  if (body === null) return null;

  const type = readString(body, 'type');
  const entry = (kind: NarrationKind, text: string, tool: string | null) =>
    text === '' && tool === null ? null : { runId, at: seqAt, kind, text, tool };

  switch (type) {
    case 'agent_message':
      return entry('said', readString(body, 'message'), null);

    case 'agent_reasoning':
    case 'agent_reasoning_delta':
      // Only present when the operator has reasoning summaries switched on.
      return entry('thinking', readString(body, 'text') || readString(body, 'delta'), null);

    case 'reasoning':
      // The recorded form. `summary` is the readable part and is routinely
      // empty - see the note this file attaches when that is what happened.
      return entry('thinking', textOf(body['summary']), null);

    case 'user_message':
      return entry('asked', readString(body, 'message'), null);

    case 'message': {
      const role = readString(body, 'role');
      // `developer` is the harness talking to the model, not either party
      // talking to the operator.
      if (role === 'developer' || role === 'system') return null;
      return entry(role === 'user' ? 'asked' : 'said', textOf(body['content']), null);
    }

    case 'custom_tool_call':
      return entry('did', readString(body, 'input'), readString(body, 'name') || 'tool');

    case 'function_call':
      return entry('did', readString(body, 'arguments'), readString(body, 'name') || 'tool');

    case 'patch_apply_end':
      return entry('did', '', 'apply_patch');

    case 'web_search_end':
      return entry('did', readString(body, 'query'), 'web_search');

    default:
      // Turn bookkeeping, token counts, settings. Real events, but not an
      // account of what the agent thought or did.
      return null;
  }
}

function fromEvents(handle: DatabaseHandle, runId: string): Parsed {
  const rows = handle.sqlite
    .prepare(
      "SELECT payload, received_at FROM events WHERE run_id = ? AND event_name = 'CodexEvent' ORDER BY seq",
    )
    .all(runId) as { payload: string; received_at: number }[];

  const entries: NarrationEntry[] = [];
  let withheld = 0;

  for (const row of rows) {
    let payload: unknown;
    try {
      payload = JSON.parse(row.payload);
    } catch {
      continue;
    }

    const entry = fromCodexEvent(payload, runId, row.received_at);
    if (entry !== null) {
      entries.push({ ...entry, seq: entries.length });
      continue;
    }

    // Counted the same way Claude's empty thinking blocks are: the model
    // reasoned and the words did not survive. Codex encrypts them.
    if (isReasoning(payload)) withheld += 1;
  }

  return { entries, withheld };
}

/** A reasoning item whose readable part did not survive. */
function isReasoning(payload: unknown): boolean {
  const body = unwrap(payload);
  if (body === null) return false;
  const type = readString(body, 'type');
  return type === 'reasoning' || type === 'agent_reasoning';
}

/* -------------------------------------------------------------------------- */

function push(
  entries: NarrationEntry[],
  runId: string,
  at: number | null,
  kind: NarrationKind,
  text: string,
  tool: string | null,
): void {
  entries.push({ runId, seq: entries.length, at, kind, text, tool });
}

/**
 * Everything the agent narrated for one card, newest run last.
 *
 * Returns the tail rather than the whole thing. A long run is tens of thousands
 * of entries and the interesting end of it is the end.
 */
export function narrationFor(
  handle: DatabaseHandle,
  cardId: string,
  options: { readonly limit?: number } = {},
): Narration {
  const limit = Math.max(1, Math.min(options.limit ?? 400, 5_000));

  const forCard = handle.db
    .select()
    .from(runs)
    .where(eq(runs.cardId, cardId))
    .orderBy(asc(runs.startedAt))
    .all();

  if (forCard.length === 0) return EMPTY;

  const all: NarrationEntry[] = [];
  const providers = new Set<'claude' | 'codex'>();
  let missingTranscript = false;
  let withheldThinking = 0;

  for (const run of forCard) {
    const streamed = fromEvents(handle, run.id);
    if (streamed.entries.length > 0 || streamed.withheld > 0) {
      providers.add('codex');
      withheldThinking += streamed.withheld;
      all.push(...streamed.entries);
      continue;
    }

    if (run.transcriptPath === null) continue;
    if (!existsSync(run.transcriptPath)) {
      missingTranscript = true;
      continue;
    }

    const parsed = fromTranscript(run.transcriptPath, run.id);
    providers.add('claude');
    withheldThinking += parsed.withheld;
    all.push(...parsed.entries);
  }

  // Renumbered across runs, so "what is new since seq N" means one thing for
  // the whole card rather than one thing per run.
  const entries = all.map((entry, index) => ({ ...entry, seq: index }));

  const provider =
    providers.size === 0 ? null : providers.size > 1 ? 'mixed' : ([...providers][0] ?? null);

  return {
    entries: entries.slice(-limit),
    total: entries.length,
    provider,
    withheldThinking,
    note: noteFor(provider, entries, missingTranscript, withheldThinking),
  };
}

/**
 * What is absent, said out loud.
 *
 * Codex withholds its reasoning: the recorded form carries `encrypted_content`
 * and an empty `summary` unless the operator has reasoning summaries switched
 * on. Measured across 25 local sessions: 1,057 reasoning items, 0 with a
 * readable summary. Without saying so, a Codex card looks like an agent that
 * thought about nothing, which is a worse answer than admitting the provider
 * does not hand it over.
 */
function noteFor(
  provider: Narration['provider'],
  entries: readonly NarrationEntry[],
  missingTranscript: boolean,
  withheld: number,
): string | null {
  if (provider === null) {
    return missingTranscript
      ? 'This run has no transcript on disk any more, so there is nothing left to replay.'
      : null;
  }

  const thought = entries.some((entry) => entry.kind === 'thinking');

  // The distinction worth drawing. A model that answered without thinking and
  // a model that thought and had its words dropped look identical on screen,
  // and only one of them is about the agent.
  if (!thought && withheld > 0) {
    return (
      `The model thought ${String(withheld)} time(s) here and none of the words were kept. ` +
      'Claude Code records the thinking block and its signature but not its text, so the ' +
      'reasoning is withheld by the harness rather than missing from the board. What it ' +
      'said and did is here in full.'
    );
  }

  if (!thought && (provider === 'codex' || provider === 'mixed')) {
    return (
      'Codex did not hand over its reasoning for this run - it encrypts it, and sends a ' +
      'readable summary only when reasoning summaries are switched on. What it said and ' +
      'did is here in full; the thinking is withheld by the provider, not missing from the board.'
    );
  }

  if (!thought) {
    return 'This run recorded no thinking - the model answered without any.';
  }

  return null;
}
