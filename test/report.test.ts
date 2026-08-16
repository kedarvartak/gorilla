import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDatabase } from '../src/server/db/client.js';
import { collectStats, fetchDiagnostics, renderReport } from '../src/server/report.js';
import { startServer, type RunningServer } from '../src/server/start.js';
import { HOOK_DEFINITIONS } from '../src/hooks/definitions.js';

let dir: string;
let dbPath: string;
let server: RunningServer | null = null;

const NOW = 1_786_000_000_000;

function seed(events: readonly { event: string; seq: number }[], runId = 'r1'): void {
  const handle = openDatabase({ path: dbPath });

  handle.sqlite
    .prepare('INSERT OR IGNORE INTO boards (id, name, cwd, created_at) VALUES (?, ?, ?, ?)')
    .run('b1', 'test', '/p', NOW);
  handle.sqlite
    .prepare(
      'INSERT OR IGNORE INTO runs (id, board_id, session_id, cwd, started_at) VALUES (?, ?, ?, ?, ?)',
    )
    .run(runId, 'b1', `session-${runId}`, '/p', NOW);

  for (const entry of events) {
    handle.sqlite
      .prepare(
        'INSERT INTO events (run_id, session_id, seq, event_name, received_at, payload) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(runId, `session-${runId}`, entry.seq, entry.event, NOW + entry.seq, '{}');
  }

  handle.close();
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gorilla-report-'));
  dbPath = join(dir, 'report.db');
});

afterEach(async () => {
  if (server !== null) {
    await server.stop();
    server = null;
  }
  rmSync(dir, { recursive: true, force: true });
});

describe('collectStats', () => {
  it('refuses to report on a database that does not exist', () => {
    expect(() => collectStats(join(dir, 'absent.db'))).toThrow(/Nothing to verify/);
  });

  it('counts events by type', () => {
    seed([
      { event: 'Stop', seq: 1 },
      { event: 'Stop', seq: 2 },
      { event: 'PreCompact', seq: 3 },
    ]);

    const stats = collectStats(dbPath);

    expect(stats.totalEvents).toBe(3);
    expect(stats.byType.find((row) => row.event === 'Stop')?.count).toBe(2);
    expect(stats.compactions).toBe(1);
  });

  it('names configured hooks that never fired', () => {
    seed([{ event: 'Stop', seq: 1 }]);

    const stats = collectStats(dbPath);

    expect(stats.missingTypes).toContain('PreCompact');
    expect(stats.missingTypes).not.toContain('Stop');
    expect(stats.missingTypes).toHaveLength(HOOK_DEFINITIONS.length - 1);
  });

  it('names events received that were never configured', () => {
    seed([{ event: 'SomethingNew', seq: 1 }]);
    expect(collectStats(dbPath).unexpectedTypes).toEqual(['SomethingNew']);
  });

  it('reports intact ordering for a dense monotonic run', () => {
    seed([1, 2, 3, 4].map((seq) => ({ event: 'Stop', seq })));

    const stats = collectStats(dbPath);

    expect(stats.orderingIntact).toBe(true);
    expect(stats.runs[0]?.seqMin).toBe(1);
    expect(stats.runs[0]?.seqMax).toBe(4);
  });

  it('detects a gap in the sequence', () => {
    // A gap is what a lost event looks like. It must not be reported as intact.
    seed([1, 2, 4].map((seq) => ({ event: 'Stop', seq })));

    const stats = collectStats(dbPath);

    expect(stats.orderingIntact).toBe(false);
    expect(stats.runs[0]?.orderingIntact).toBe(false);
  });

  it('detects a run that does not start at one', () => {
    seed([2, 3].map((seq) => ({ event: 'Stop', seq })));
    expect(collectStats(dbPath).orderingIntact).toBe(false);
  });

  it('reports ordering per run independently', () => {
    seed(
      [1, 2].map((seq) => ({ event: 'Stop', seq })),
      'r1',
    );
    seed(
      [1, 3].map((seq) => ({ event: 'Stop', seq })),
      'r2',
    );

    const stats = collectStats(dbPath);

    expect(stats.runs).toHaveLength(2);
    expect(stats.orderingIntact).toBe(false);
    expect(stats.runs.filter((run) => run.orderingIntact)).toHaveLength(1);
  });
});

describe('fetchDiagnostics', () => {
  it('returns null when nothing is listening, rather than throwing', async () => {
    expect(await fetchDiagnostics('http://127.0.0.1:4999')).toBeNull();
  });

  it('reads latency percentiles from a running server', async () => {
    server = await startServer({ port: 4483, dbPath: join(dir, 'live.db'), logger: false });

    await fetch(`${server.url}/hooks/Stop`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: 's', cwd: '/p', hook_event_name: 'Stop' }),
    });

    const diagnostics = await fetchDiagnostics(server.url);

    expect(diagnostics).not.toBeNull();
    expect(diagnostics?.samples).toBeGreaterThan(0);
    expect(diagnostics?.p99).toBeGreaterThanOrEqual(0);
  });
});

describe('renderReport', () => {
  it('says plainly when latency could not be measured', () => {
    seed([{ event: 'Stop', seq: 1 }]);
    const output = renderReport(collectStats(dbPath), null, NOW);

    // The guardrail: an unavailable measurement is stated, never estimated.
    expect(output).toContain('**Not available.**');
    expect(output).not.toMatch(/\d+\.\d+ ms/);
  });

  it('reports the budget verdict against a measured p99', () => {
    seed([{ event: 'Stop', seq: 1 }]);

    const inside = renderReport(
      collectStats(dbPath),
      { uptimeMs: 1, samples: 10, p50: 0.3, p95: 0.6, p99: 3.8, max: 3.8 },
      NOW,
    );
    expect(inside).toContain('Inside the 25 ms p99 budget');

    const outside = renderReport(
      collectStats(dbPath),
      { uptimeMs: 1, samples: 10, p50: 0.3, p95: 30, p99: 40, max: 90 },
      NOW,
    );
    expect(outside).toContain('**Outside** the 25 ms p99 budget');
  });

  it('states when no compaction occurred rather than staying silent', () => {
    seed([{ event: 'Stop', seq: 1 }]);
    expect(renderReport(collectStats(dbPath), null, NOW)).toContain('did not fire');
  });

  it('flags broken ordering prominently', () => {
    seed([1, 3].map((seq) => ({ event: 'Stop', seq })));
    expect(renderReport(collectStats(dbPath), null, NOW)).toContain('**Broken.**');
  });

  it('lists every hook that never fired', () => {
    seed([{ event: 'Stop', seq: 1 }]);
    const output = renderReport(collectStats(dbPath), null, NOW);

    expect(output).toContain('`PreCompact`');
    expect(output).toContain('Hooks that never fired');
  });
});
