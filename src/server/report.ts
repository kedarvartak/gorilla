import { existsSync } from 'node:fs';

import { openDatabase } from './db/client.js';
import { HOOK_DEFINITIONS } from '../hooks/definitions.js';

/**
 * Phase 0 verification statistics (T10).
 *
 * Every figure here is computed from the database or from the running server.
 * Nothing is estimated, and where a measurement is unavailable the report says
 * so rather than substituting a plausible number - the failure mode of a
 * self-written verification report is that it reads as though everything went
 * well.
 */

export interface EventTypeCount {
  readonly event: string;
  readonly count: number;
  readonly firstAt: number;
  readonly lastAt: number;
}

export interface RunSummary {
  readonly runId: string;
  readonly sessionId: string;
  readonly events: number;
  readonly startedAt: number;
  readonly lastEventAt: number;
  readonly transcriptPath: string | null;
  /** True when this run's seq values are 1..n with no gaps and no duplicates. */
  readonly orderingIntact: boolean;
  readonly seqMin: number;
  readonly seqMax: number;
}

export interface UnresolvedIntent {
  readonly toolName: string;
  readonly count: number;
}

export interface VerificationStats {
  readonly databasePath: string;
  readonly totalEvents: number;
  readonly byType: readonly EventTypeCount[];
  readonly missingTypes: readonly string[];
  readonly unexpectedTypes: readonly string[];
  readonly runs: readonly RunSummary[];
  readonly boards: number;
  readonly compactions: number;
  readonly orderingIntact: boolean;
  readonly wallClockMs: number;
  /**
   * Tool calls announced by PreToolUse with no PostToolUse and no
   * PostToolUseFailure.
   *
   * This is how a denial looks to the board. Measured on 2.1.233: under
   * `dontAsk` a refused call emits neither PermissionDenied nor
   * PostToolUseFailure, so the absence is the only signal there is (doc 15).
   * An intent with no outcome is exactly the kind of thing the operator should
   * hear about, so it is counted rather than left to be inferred from a
   * mismatch between two totals.
   */
  readonly unresolvedIntents: readonly UnresolvedIntent[];
  readonly unresolvedTotal: number;
}

interface CountRow {
  event_name: string;
  n: number;
  first_at: number;
  last_at: number;
}

interface RunRow {
  id: string;
  session_id: string;
  started_at: number;
  transcript_path: string | null;
}

interface SeqRow {
  n: number;
  min_seq: number;
  max_seq: number;
  distinct_seq: number;
  last_at: number;
}

export function collectStats(databasePath: string): VerificationStats {
  if (!existsSync(databasePath)) {
    throw new Error(`No database at ${databasePath}. Nothing to verify.`);
  }

  const handle = openDatabase({ path: databasePath, migrate: false });

  try {
    const byType = (
      handle.sqlite
        .prepare(
          'SELECT event_name, COUNT(*) AS n, MIN(received_at) AS first_at, MAX(received_at) AS last_at FROM events GROUP BY event_name ORDER BY n DESC',
        )
        .all() as CountRow[]
    ).map((row) => ({
      event: row.event_name,
      count: row.n,
      firstAt: row.first_at,
      lastAt: row.last_at,
    }));

    const seen = new Set(byType.map((row) => row.event));
    const configured = new Set(HOOK_DEFINITIONS.map((d) => d.event));

    const runRows = handle.sqlite
      .prepare('SELECT id, session_id, started_at, transcript_path FROM runs ORDER BY started_at')
      .all() as RunRow[];

    const runs: RunSummary[] = runRows.map((run) => {
      const seq = handle.sqlite
        .prepare(
          'SELECT COUNT(*) AS n, MIN(seq) AS min_seq, MAX(seq) AS max_seq, COUNT(DISTINCT seq) AS distinct_seq, MAX(received_at) AS last_at FROM events WHERE run_id = ?',
        )
        .get(run.id) as SeqRow;

      // Dense, monotonic, no duplicates: 1..n with n distinct values.
      const intact =
        seq.n === 0 || (seq.min_seq === 1 && seq.max_seq === seq.n && seq.distinct_seq === seq.n);

      return {
        runId: run.id,
        sessionId: run.session_id,
        events: seq.n,
        startedAt: run.started_at,
        lastEventAt: seq.last_at ?? run.started_at,
        transcriptPath: run.transcript_path,
        orderingIntact: intact,
        seqMin: seq.min_seq ?? 0,
        seqMax: seq.max_seq ?? 0,
      };
    });

    // Per tool: intents minus outcomes. Counted by tool rather than in
    // aggregate so the report can name what was refused.
    const unresolvedRows = handle.sqlite
      .prepare(
        `SELECT tool_name AS tool,
                SUM(CASE WHEN event_name = 'PreToolUse' THEN 1 ELSE 0 END) AS intents,
                SUM(CASE WHEN event_name IN ('PostToolUse', 'PostToolUseFailure') THEN 1 ELSE 0 END) AS outcomes
         FROM events
         WHERE tool_name IS NOT NULL
         GROUP BY tool_name`,
      )
      .all() as { tool: string; intents: number; outcomes: number }[];

    const unresolvedIntents = unresolvedRows
      .map((row) => ({ toolName: row.tool, count: row.intents - row.outcomes }))
      .filter((row) => row.count > 0)
      .sort((a, b) => b.count - a.count);

    const totals = handle.sqlite
      .prepare('SELECT COUNT(*) AS n, MIN(received_at) AS a, MAX(received_at) AS b FROM events')
      .get() as { n: number; a: number | null; b: number | null };

    const boards = (
      handle.sqlite.prepare('SELECT COUNT(*) AS n FROM boards').get() as { n: number }
    ).n;

    return {
      databasePath,
      totalEvents: totals.n,
      byType,
      missingTypes: [...configured].filter((event) => !seen.has(event)).sort(),
      unexpectedTypes: [...seen].filter((event) => !configured.has(event)).sort(),
      runs,
      boards,
      compactions: byType.find((row) => row.event === 'PreCompact')?.count ?? 0,
      orderingIntact: runs.every((run) => run.orderingIntact),
      wallClockMs: totals.a === null || totals.b === null ? 0 : totals.b - totals.a,
      unresolvedIntents,
      unresolvedTotal: unresolvedIntents.reduce((sum, row) => sum + row.count, 0),
    };
  } finally {
    handle.close();
  }
}

export interface LiveDiagnostics {
  readonly uptimeMs: number;
  readonly samples: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly max: number;
}

/** Null when the server is not reachable, which the report must state. */
export async function fetchDiagnostics(url: string): Promise<LiveDiagnostics | null> {
  try {
    const response = await fetch(`${url.replace(/\/+$/, '')}/diagnostics`, {
      signal: AbortSignal.timeout(2_000),
    });
    if (!response.ok) return null;
    return (await response.json()) as LiveDiagnostics;
  } catch {
    return null;
  }
}

const isoOrDash = (ms: number): string => (ms > 0 ? new Date(ms).toISOString() : '-');

export function renderReport(
  stats: VerificationStats,
  diagnostics: LiveDiagnostics | null,
  now: number,
): string {
  const lines: string[] = [];

  lines.push('# Phase 0 verification statistics');
  lines.push('');
  lines.push(`Generated ${new Date(now).toISOString()} from \`${stats.databasePath}\`.`);
  lines.push('');
  lines.push('Every figure below is a query result. Where a measurement was unavailable the');
  lines.push('report says so rather than substituting an estimate.');
  lines.push('');

  lines.push('## Events received');
  lines.push('');
  lines.push(
    `Total: **${stats.totalEvents}** across ${stats.runs.length} run(s) and ${stats.boards} board(s).`,
  );
  lines.push(`Span: ${isoOrDash(stats.byType[0]?.firstAt ?? 0)} to ${isoOrDash(now)}.`);
  lines.push('');
  lines.push('| Event | Count | First | Last |');
  lines.push('| --- | --- | --- | --- |');
  for (const row of [...stats.byType].sort((a, b) => a.event.localeCompare(b.event))) {
    lines.push(
      `| \`${row.event}\` | ${row.count} | ${isoOrDash(row.firstAt)} | ${isoOrDash(row.lastAt)} |`,
    );
  }
  lines.push('');

  lines.push('## Hooks that never fired');
  lines.push('');
  if (stats.missingTypes.length === 0) {
    lines.push('None. Every configured hook delivered at least once.');
  } else {
    lines.push('These are configured in doc 07 but delivered nothing during this run:');
    lines.push('');
    for (const event of stats.missingTypes) lines.push(`- \`${event}\``);
  }
  lines.push('');

  if (stats.unexpectedTypes.length > 0) {
    lines.push('Events received that are not in the configured list:');
    lines.push('');
    for (const event of stats.unexpectedTypes) lines.push(`- \`${event}\``);
    lines.push('');
  }

  lines.push('## Ordering');
  lines.push('');
  lines.push(
    stats.orderingIntact
      ? 'Intact. Every run has dense, monotonic, duplicate-free sequence numbers from 1.'
      : '**Broken.** At least one run has gaps or duplicates in its sequence numbers.',
  );
  lines.push('');
  lines.push('| Run | Session | Events | seq range | Intact |');
  lines.push('| --- | --- | --- | --- | --- |');
  for (const run of stats.runs) {
    lines.push(
      `| \`${run.runId.slice(0, 8)}\` | \`${run.sessionId.slice(0, 8)}\` | ${run.events} | ${run.seqMin}-${run.seqMax} | ${run.orderingIntact ? 'yes' : 'NO'} |`,
    );
  }
  lines.push('');

  lines.push('## Ingest latency');
  lines.push('');
  if (diagnostics === null) {
    lines.push('**Not available.** Latency is held in the running process, so it can only be');
    lines.push('read while the server that received the events is still up. Restart the run and');
    lines.push('generate the report before stopping the server.');
  } else {
    lines.push(`Measured over ${diagnostics.samples} ingested event(s):`);
    lines.push('');
    lines.push('| p50 | p95 | p99 | max |');
    lines.push('| --- | --- | --- | --- |');
    lines.push(
      `| ${diagnostics.p50.toFixed(2)} ms | ${diagnostics.p95.toFixed(2)} ms | ${diagnostics.p99.toFixed(2)} ms | ${diagnostics.max.toFixed(2)} ms |`,
    );
    lines.push('');
    lines.push(
      diagnostics.p99 < 25
        ? `Inside the 25 ms p99 budget from doc 06.`
        : `**Outside** the 25 ms p99 budget from doc 06.`,
    );
  }
  lines.push('');

  lines.push('## Tool intents with no outcome');
  lines.push('');
  if (stats.unresolvedTotal === 0) {
    lines.push('None. Every announced tool call reported an outcome.');
  } else {
    lines.push(
      `**${stats.unresolvedTotal}** tool call(s) were announced by \`PreToolUse\` and never ` +
        'reported an outcome. The usual cause is a denied permission, which on this Claude Code ' +
        'version emits no event of its own.',
    );
    lines.push('');
    lines.push('| Tool | Unresolved |');
    lines.push('| --- | --- |');
    for (const row of stats.unresolvedIntents) {
      lines.push(`| \`${row.toolName}\` | ${row.count} |`);
    }
  }
  lines.push('');

  lines.push('## Compaction');
  lines.push('');
  lines.push(
    stats.compactions > 0
      ? `\`PreCompact\` fired ${stats.compactions} time(s).`
      : '`PreCompact` did not fire. The session was not long enough to compact, so the ' +
          'compaction findings cannot be confirmed under real conditions by this run.',
  );

  return `${lines.join('\n')}\n`;
}
