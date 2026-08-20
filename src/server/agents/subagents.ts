import type { Database } from 'better-sqlite3';

/**
 * A subagent's work, as its own thing (doc 05).
 *
 * A subagent is the one place where work happens and leaves the operator
 * nothing to read. Its context window is discarded at `SubagentStop`, and the
 * parent keeps only the message it returned - so eight files edited inside a
 * subagent arrive in the blast radius with no account of why, attributed to a
 * session that did not do them.
 *
 * The timeline already indents these events, which answers "did a subagent do
 * this?" but not "what did it do". This groups them: what kind of agent, how
 * long it ran, what it touched, and what it said on the way out.
 *
 * Built from `SubagentStart`, `SubagentStop` and the `agent_id` on tool events.
 * `TaskCreated` and `TaskCompleted` are registered hooks that have never
 * delivered a single event, so nothing here depends on them; when they start
 * arriving they will land in the same group by `agent_id`.
 */

export interface SubagentSummary {
  readonly agentId: string;
  /** From `SubagentStart`. `SubagentStop` frequently carries an empty string. */
  readonly agentType: string | null;
  /** Null when the board only ever saw this subagent stop. */
  readonly startedAt: number | null;
  readonly endedAt: number | null;
  readonly toolCalls: number;
  readonly files: readonly string[];
  /** What it handed back. The only part of its reasoning that survives. */
  readonly result: string | null;
  /** The subagent's own transcript, when Claude Code named one. */
  readonly transcriptPath: string | null;
  readonly finished: boolean;
}

interface EventRow {
  event_name: string;
  received_at: number;
  payload: string;
  agent_id: string;
}

/** The longest returned message kept. Enough to recognise, not to drown in. */
export const MAX_RESULT_CHARS = 600;

function readString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

function parse(payload: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(payload);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export function summariseSubagents(sqlite: Database, runId: string): SubagentSummary[] {
  const rows = sqlite
    .prepare(
      `SELECT event_name, received_at, payload, agent_id
         FROM events
        WHERE run_id = ? AND agent_id IS NOT NULL
        ORDER BY seq ASC`,
    )
    .all(runId) as EventRow[];

  const byAgent = new Map<string, SubagentSummary & { files: string[] }>();

  for (const row of rows) {
    const payload = parse(row.payload);

    const existing = byAgent.get(row.agent_id) ?? {
      agentId: row.agent_id,
      agentType: null,
      startedAt: null,
      endedAt: null,
      toolCalls: 0,
      files: [] as string[],
      result: null,
      transcriptPath: null,
      finished: false,
    };

    const next = { ...existing, files: existing.files };

    // Type comes from whichever event actually carried one. Start is the
    // reliable source; taking Stop's empty string would erase it.
    next.agentType = next.agentType ?? readString(payload, 'agent_type');

    if (row.event_name === 'SubagentStart') {
      next.startedAt = row.received_at;
    } else if (row.event_name === 'SubagentStop') {
      next.endedAt = row.received_at;
      next.finished = true;
      next.result = truncate(readString(payload, 'last_assistant_message'));
      next.transcriptPath = readString(payload, 'agent_transcript_path');
    } else if (row.event_name === 'PreToolUse') {
      // Counted on PreToolUse only. Counting both halves of every tool call
      // would double every number in this view.
      next.toolCalls += 1;

      const target = readString(
        (payload['tool_input'] ?? {}) as Record<string, unknown>,
        'file_path',
      );
      if (target !== null && !next.files.includes(target)) next.files.push(target);
    }

    byAgent.set(row.agent_id, next);
  }

  return [...byAgent.values()].sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
}

function truncate(text: string | null): string | null {
  if (text === null) return null;
  return text.length <= MAX_RESULT_CHARS ? text : `${text.slice(0, MAX_RESULT_CHARS)}…`;
}

/**
 * How long it ran, or nothing.
 *
 * Returns null when the board never saw the subagent start - which is most of
 * them on any board that was configured after the fact. Deriving a duration
 * from the first tool call instead would produce a number that looks measured
 * and is guessed, and everything in this view is meant to be evidence.
 */
export function durationOf(summary: SubagentSummary): number | null {
  if (summary.startedAt === null || summary.endedAt === null) return null;
  return summary.endedAt - summary.startedAt;
}

export function describeSubagent(summary: SubagentSummary): string {
  const kind = summary.agentType ?? 'subagent';
  const ran = summary.finished ? 'ran' : 'is running';
  const tools = `${String(summary.toolCalls)} tool call(s)`;
  const files = summary.files.length === 0 ? 'no files' : `${String(summary.files.length)} file(s)`;

  return `${kind} ${ran}: ${tools}, ${files}`;
}
