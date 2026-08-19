import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';

import { parseObject, readString, toolInput, toolPath } from '../json.js';

/**
 * The extraction window: the slice of a run handed to one model call (doc 08).
 *
 * Two jobs, both about cost rather than quality. It decides what a window even
 * contains - events plus the assistant's own narration, because the reasoning
 * the ledger wants lives in the prose and the evidence lives in the events -
 * and it decides when a window is not worth a model call at all.
 *
 * Nothing here calls a model. A window is a value, hashable, so an unchanged
 * window is free to re-extract (doc 08, cost control).
 */

export type WindowTrigger =
  'Stop' | 'SubagentStop' | 'PreCompact' | 'PostToolUseFailure' | 'manual';

/** Triggers whose content will not exist again, and so are never skipped or trimmed first. */
const IRREPLACEABLE: ReadonlySet<WindowTrigger> = new Set<WindowTrigger>(['PreCompact', 'manual']);

export interface WindowEventRow {
  id: number;
  seq: number;
  event_name: string;
  tool_name: string | null;
  payload: string;
}

export interface ExtractionWindow {
  readonly runId: string;
  readonly trigger: WindowTrigger;
  /** Every event id in the window. The only ids an extracted entry may cite. */
  readonly eventIds: readonly number[];
  /** Rendered window, already truncated to the ceiling. What the model sees. */
  readonly text: string;
  /** File paths touched in this window, so the validator can spot diff restatement. */
  readonly filePaths: readonly string[];
  readonly mutatingToolCalls: number;
  readonly narrativeChars: number;
  readonly truncated: boolean;
  /** Content hash over trigger and text. The cache key (doc 08). */
  readonly hash: string;
}

export interface WindowInput {
  readonly sqlite: Database.Database;
  readonly runId: string;
  readonly trigger: WindowTrigger;
  /** Exclusive lower bound - the seq the previous window ended on. */
  readonly afterSeq?: number;
  readonly throughSeq?: number;
  /** Assistant prose for this window, newest last. Usually from the transcript reader. */
  readonly narrative?: readonly string[];
  readonly maxChars?: number;
}

const MUTATING_TOOLS: ReadonlySet<string> = new Set(['Edit', 'Write', 'NotebookEdit', 'Bash']);

/** Roughly four characters per token, which is close enough to budget a window. */
const DEFAULT_MAX_CHARS = 24_000;

/** Below this much assistant prose, a turn with no mutation has nothing to reason about. */
export const NARRATIVE_FLOOR_CHARS = 240;

/**
 * Lines worth keeping when a window is over budget. Doc 08 asks for the tail
 * plus "content matching decision-shaped patterns" - this is that list, and it
 * is intentionally about reasoning verbs rather than topics.
 */
const DECISION_SHAPED =
  /\b(decid|chose|choos|instead of|rather than|because|so that|trade-?off|assum|risk|blocked|cannot|can't|won't|will not|deliberat|on purpose|reverted|superseded)/i;

/** One line per event: enough for the model to cite it, short enough to afford. */
function renderEvent(row: WindowEventRow): string {
  const payload = parseObject(row.payload);
  const parts: string[] = [`#${row.id} ${row.event_name}`];

  if (row.tool_name !== null) parts.push(row.tool_name);

  const path = toolPath(payload);
  const command = readString(toolInput(payload), 'command');
  const error = readString(payload, 'tool_error') ?? readString(payload, 'error_type');
  const denial = readString(payload, 'denial_reason');

  if (path !== null) parts.push(path);
  if (command !== null) parts.push(`\`${command.slice(0, 200)}\``);
  if (error !== null) parts.push(`error: ${error}`);
  if (denial !== null) parts.push(`denied: ${denial}`);

  return parts.join(' ');
}

/**
 * Trims to the ceiling by dropping the least interesting lines first: oldest
 * first, and decision-shaped lines only once nothing else is left. The tail
 * always survives, because the end of a window is where its conclusions are.
 */
function truncate(
  lines: readonly string[],
  maxChars: number,
): { text: string; truncated: boolean } {
  const joined = lines.join('\n');
  if (joined.length <= maxChars) return { text: joined, truncated: false };

  const kept: string[] = [];
  let budget = maxChars;

  // Walk newest to oldest so the tail is kept unconditionally.
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i] ?? '';
    if (line.length + 1 <= budget) {
      kept.unshift(line);
      budget -= line.length + 1;
      continue;
    }
    // Out of room. Keep scanning for decision-shaped lines that still fit.
    if (DECISION_SHAPED.test(line) && line.length + 1 <= budget) {
      kept.unshift(line);
      budget -= line.length + 1;
    }
  }

  return { text: ['[window truncated]', ...kept].join('\n'), truncated: true };
}

export function buildWindow(input: WindowInput): ExtractionWindow {
  const after = input.afterSeq ?? 0;
  const through = input.throughSeq ?? Number.MAX_SAFE_INTEGER;

  const rows = input.sqlite
    .prepare(
      `SELECT id, seq, event_name, tool_name, payload FROM events
       WHERE run_id = ? AND seq > ? AND seq <= ? ORDER BY seq`,
    )
    .all(input.runId, after, through) as WindowEventRow[];

  const filePaths = new Set<string>();
  let mutatingToolCalls = 0;

  for (const row of rows) {
    const payload = parseObject(row.payload);
    if (row.event_name === 'PostToolUse' && row.tool_name !== null) {
      if (MUTATING_TOOLS.has(row.tool_name)) mutatingToolCalls += 1;
    }
    const path = toolPath(payload);
    if (path !== null) filePaths.add(path);
  }

  const narrative = (input.narrative ?? []).filter((text) => text.trim() !== '');
  const narrativeChars = narrative.join('\n').length;

  const lines = [
    `## Events (${rows.length})`,
    ...rows.map(renderEvent),
    '',
    `## What the agent said (${narrative.length} message(s))`,
    ...narrative,
  ];

  const { text, truncated } = truncate(lines, input.maxChars ?? DEFAULT_MAX_CHARS);

  return {
    runId: input.runId,
    trigger: input.trigger,
    eventIds: rows.map((row) => row.id),
    text,
    filePaths: [...filePaths],
    mutatingToolCalls,
    narrativeChars,
    truncated,
    hash: createHash('sha256').update(`${input.trigger}\n${text}`).digest('hex').slice(0, 32),
  };
}

export interface SkipDecision {
  readonly skip: boolean;
  readonly reason?: string;
}

/**
 * Whether this window is worth a model call.
 *
 * "Turns that produced no mutating tool calls and no assistant text above a
 * length floor skip model extraction entirely" (doc 08). A `PreCompact` window
 * is exempt from everything except being genuinely empty: its content is about
 * to stop existing, so the bar for spending on it is as low as it goes.
 */
export function shouldSkipModel(window: ExtractionWindow): SkipDecision {
  if (window.eventIds.length === 0 && window.narrativeChars === 0) {
    return { skip: true, reason: 'the window is empty' };
  }
  if (IRREPLACEABLE.has(window.trigger)) return { skip: false };

  if (window.mutatingToolCalls === 0 && window.narrativeChars < NARRATIVE_FLOOR_CHARS) {
    return { skip: true, reason: 'no mutating tool calls and little narration' };
  }
  return { skip: false };
}
