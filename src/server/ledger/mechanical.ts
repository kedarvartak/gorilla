import type Database from 'better-sqlite3';

import { parseObject, readString, toolInput, toolPath } from '../json.js';

/**
 * The mechanical ledger (P11).
 *
 * Deterministic entries only - no model calls, no API key, no cost. Everything
 * here is derived from events the board already has, and every entry names the
 * events it came from.
 *
 * This is the phase gate. If a ledger with no synthesis at all is not already
 * worth reading, the extraction pipeline in Phase 2 will not rescue it, and it
 * is far cheaper to learn that here (doc 16).
 */

export type MechanicalKind = 'change' | 'risk' | 'question' | 'verdict';

export interface MechanicalEntry {
  readonly kind: MechanicalKind;
  /** One sentence, actionable by someone who was not watching. */
  readonly statement: string;
  readonly detail?: string;
  readonly filePaths?: readonly string[];
  /** Event ids this was derived from. An entry with no source is not emitted. */
  readonly sourceEventIds: readonly number[];
}

interface EventRow {
  id: number;
  event_name: string;
  payload: string;
  tool_name: string | null;
  received_at: number;
}

function commandFrom(payload: Record<string, unknown>): string | null {
  return readString(toolInput(payload), 'command');
}

/**
 * Bash commands whose effect outlives the session. A dependency added or a
 * migration run is material even when the agent never narrated it, and it is
 * the kind of change that is expensive to discover weeks later.
 */
const MATERIAL_COMMANDS: readonly { pattern: RegExp; what: string }[] = [
  { pattern: /\b(npm|pnpm|yarn|bun)\s+(i|install|add)\b/, what: 'added or changed a dependency' },
  { pattern: /\bpip3?\s+install\b/, what: 'added a Python dependency' },
  { pattern: /\bcargo\s+add\b/, what: 'added a Rust dependency' },
  { pattern: /\bgo\s+get\b/, what: 'added a Go dependency' },
  { pattern: /\b(migrate|migration)\b/, what: 'ran a migration' },
  { pattern: /\bdrizzle-kit\s+(generate|push|migrate)\b/, what: 'changed the database schema' },
  { pattern: /\bgit\s+(push|reset\s+--hard|rebase|force)/, what: 'performed a history operation' },
  { pattern: /\brm\s+-rf?\b/, what: 'deleted files' },
];

export interface MechanicalLedgerInput {
  readonly sqlite: Database.Database;
  readonly runId: string;
}

/** File changes, aggregated per file so twenty edits to one file read as one line. */
export function changeEntries(input: MechanicalLedgerInput): MechanicalEntry[] {
  const rows = input.sqlite
    .prepare(
      `SELECT id, event_name, payload, tool_name, received_at FROM events
       WHERE run_id = ? AND event_name = 'PostToolUse'
         AND tool_name IN ('Edit', 'Write', 'NotebookEdit')
       ORDER BY seq`,
    )
    .all(input.runId) as EventRow[];

  const byFile = new Map<string, { ids: number[]; tools: Set<string> }>();

  for (const row of rows) {
    const path = toolPath(parseObject(row.payload));
    if (path === null) continue;

    const existing = byFile.get(path) ?? { ids: [], tools: new Set<string>() };
    existing.ids.push(row.id);
    if (row.tool_name !== null) existing.tools.add(row.tool_name);
    byFile.set(path, existing);
  }

  return [...byFile.entries()].map(([path, info]) => ({
    kind: 'change' as const,
    statement: `${path} was modified (${info.ids.length} ${info.ids.length === 1 ? 'edit' : 'edits'})`,
    detail: `Tools: ${[...info.tools].join(', ')}`,
    filePaths: [path],
    sourceEventIds: info.ids,
  }));
}

/** Material shell commands, which change the project beyond the files edited. */
export function commandEntries(input: MechanicalLedgerInput): MechanicalEntry[] {
  const rows = input.sqlite
    .prepare(
      `SELECT id, event_name, payload, tool_name, received_at FROM events
       WHERE run_id = ? AND tool_name = 'Bash' AND event_name IN ('PreToolUse', 'PostToolUse')
       ORDER BY seq`,
    )
    .all(input.runId) as EventRow[];

  const entries: MechanicalEntry[] = [];
  const seen = new Set<string>();

  for (const row of rows) {
    const command = commandFrom(parseObject(row.payload));
    if (command === null) continue;

    for (const { pattern, what } of MATERIAL_COMMANDS) {
      if (!pattern.test(command)) continue;

      const key = `${what}:${command}`;
      if (seen.has(key)) continue;
      seen.add(key);

      entries.push({
        kind: 'change',
        statement: `The agent ${what}`,
        detail: command,
        sourceEventIds: [row.id],
      });
      break;
    }
  }

  return entries;
}

/**
 * Failures and refusals.
 *
 * A denied tool call is the interesting case: measured on Claude Code 2.1.233,
 * a refusal under `dontAsk` emits no PermissionDenied and no
 * PostToolUseFailure, only a PreToolUse with nothing after it (doc 15). So the
 * absence is the signal, and "tried three times and was refused" reaches the
 * operator rather than vanishing.
 */
export function riskEntries(input: MechanicalLedgerInput): MechanicalEntry[] {
  const entries: MechanicalEntry[] = [];

  const failures = input.sqlite
    .prepare(
      `SELECT id, event_name, payload, tool_name, received_at FROM events
       WHERE run_id = ? AND event_name IN ('PostToolUseFailure', 'StopFailure')
       ORDER BY seq`,
    )
    .all(input.runId) as EventRow[];

  for (const row of failures) {
    const payload = parseObject(row.payload);
    const reason =
      readString(payload, 'tool_error') ?? readString(payload, 'error_type') ?? 'unspecified';

    entries.push({
      kind: 'risk',
      statement:
        row.event_name === 'StopFailure'
          ? `The turn ended on an API failure (${reason})`
          : `${row.tool_name ?? 'A tool'} failed`,
      detail: reason,
      sourceEventIds: [row.id],
    });
  }

  const denied = input.sqlite
    .prepare(
      `SELECT id, event_name, payload, tool_name, received_at FROM events
       WHERE run_id = ? AND event_name = 'PermissionDenied' ORDER BY seq`,
    )
    .all(input.runId) as EventRow[];

  for (const row of denied) {
    entries.push({
      kind: 'risk',
      statement: `${row.tool_name ?? 'A tool'} call was denied`,
      detail: readString(parseObject(row.payload), 'denial_reason') ?? 'no reason given',
      sourceEventIds: [row.id],
    });
  }

  entries.push(...unresolvedIntentEntries(input));
  return entries;
}

/** Tool intents with no outcome: how a refusal looks when nothing reports it. */
export function unresolvedIntentEntries(input: MechanicalLedgerInput): MechanicalEntry[] {
  const rows = input.sqlite
    .prepare(
      `SELECT tool_name AS tool,
              SUM(CASE WHEN event_name = 'PreToolUse' THEN 1 ELSE 0 END) AS intents,
              SUM(CASE WHEN event_name IN ('PostToolUse', 'PostToolUseFailure') THEN 1 ELSE 0 END) AS outcomes,
              GROUP_CONCAT(CASE WHEN event_name = 'PreToolUse' THEN id END) AS ids
       FROM events
       WHERE run_id = ? AND tool_name IS NOT NULL
       GROUP BY tool_name`,
    )
    .all(input.runId) as { tool: string; intents: number; outcomes: number; ids: string | null }[];

  return rows
    .filter((row) => row.intents - row.outcomes > 0)
    .map((row) => ({
      kind: 'risk' as const,
      statement: `${row.tool} was attempted ${row.intents - row.outcomes} time(s) with no outcome recorded`,
      detail:
        'The usual cause is a denied permission, which on this Claude Code version emits no event of its own.',
      sourceEventIds: (row.ids ?? '')
        .split(',')
        .filter((id) => id !== '')
        .map((id) => Number(id)),
    }));
}

export interface GoalVerdictInput {
  readonly verdict: string;
  readonly reason: string;
  readonly at: number;
}

/**
 * Goal verdicts, including the evaluator's stated reason for each "not yet
 * met". That reason is a free, high-signal record of what the agent believed
 * was still outstanding, and it costs nothing to keep.
 */
export function verdictEntries(verdicts: readonly GoalVerdictInput[]): MechanicalEntry[] {
  return verdicts.map((verdict) => ({
    kind: 'verdict' as const,
    statement: `Goal evaluated: ${verdict.verdict}`,
    detail: verdict.reason,
    sourceEventIds: [],
  }));
}

export interface MechanicalLedger {
  readonly entries: readonly MechanicalEntry[];
  readonly changed: readonly string[];
  readonly risks: number;
}

export function buildMechanicalLedger(input: MechanicalLedgerInput): MechanicalLedger {
  const changes = changeEntries(input);
  const commands = commandEntries(input);
  const risks = riskEntries(input);

  const entries = [...changes, ...commands, ...risks].filter(
    // Traceability is enforced here rather than asserted in a document: an
    // entry that cannot name its evidence is not shown at all.
    (entry) => entry.kind === 'verdict' || entry.sourceEventIds.length > 0,
  );

  return {
    entries,
    changed: changes.flatMap((entry) => entry.filePaths ?? []),
    risks: risks.length,
  };
}
