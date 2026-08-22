import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { formatReport, runDoctor, type DoctorReport } from '../src/cli/commands/doctor.js';
import { runInit } from '../src/cli/commands/init.js';
import { HOOK_DEFINITIONS } from '../src/hooks/definitions.js';
import { openDatabase } from '../src/server/db/client.js';
import { boards } from '../src/server/db/schema.js';
import { startServer, type RunningServer } from '../src/server/start.js';

let dir: string;
let dbPath: string;
let server: RunningServer | null = null;

const PORT = 4481;

// Pointed at the port these tests actually serve on. Initialising the hooks at
// one port and starting the board at another is a real misconfiguration - the
// one `hook target` exists to catch - and a fixture that models it by accident
// makes every other assertion here argue with it.
const initBase = {
  shared: false,
  dryRun: false,
  force: false,
  baseUrl: `http://127.0.0.1:${String(PORT)}`,
};

function check(report: DoctorReport, name: string): { status: string; detail: string } {
  const found = report.checks.find((c) => c.name === name);
  if (found === undefined) throw new Error(`no check named ${name}`);
  return found;
}

function seedEvents(events: readonly string[], receivedAt = Date.now()): void {
  const handle = openDatabase({ path: dbPath });
  handle.sqlite
    .prepare('INSERT INTO boards (id, name, cwd, created_at) VALUES (?, ?, ?, ?)')
    .run('b1', 'test', dir, Date.now());
  handle.sqlite
    .prepare(
      'INSERT INTO runs (id, board_id, session_id, cwd, started_at, transcript_path) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run('r1', 'b1', 's1', dir, Date.now(), join(dir, 'transcript.jsonl'));

  let seq = 0;
  for (const event of events) {
    seq += 1;
    handle.sqlite
      .prepare(
        'INSERT INTO events (run_id, session_id, seq, event_name, received_at, payload) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run('r1', 's1', seq, event, receivedAt, '{}');
  }
  handle.close();
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gorilla-doctor-'));
  mkdirSync(join(dir, '.claude'), { recursive: true });
  dbPath = join(dir, 'doctor.db');
});

afterEach(async () => {
  if (server !== null) {
    await server.stop();
    server = null;
  }
  rmSync(dir, { recursive: true, force: true });
});

describe('a project that has not been initialised', () => {
  it('names the missing configuration and fails', async () => {
    const report = await runDoctor({ cwd: dir, port: PORT, dbPath });

    expect(report.ok).toBe(false);
    expect(check(report, 'hook configuration').status).toBe('fail');
    expect(check(report, 'hook configuration').detail).toContain('gorilla init');
  });

  it('exits non-zero so the verification run can gate on it', async () => {
    const report = await runDoctor({ cwd: dir, port: PORT, dbPath });
    expect(formatReport(report)).toContain('Configuration problems found.');
  });
});

describe('a correctly configured project', () => {
  beforeEach(() => {
    runInit({ ...initBase, cwd: dir });
  });

  it('reports the hooks as registered', async () => {
    const report = await runDoctor({ cwd: dir, port: PORT, dbPath });

    const configuration = check(report, 'hook configuration');
    expect(configuration.status).toBe('ok');
    expect(configuration.detail).toContain(String(HOOK_DEFINITIONS.length));
  });

  it('does not fail merely because the server is not running', async () => {
    const report = await runDoctor({ cwd: dir, port: PORT, dbPath });

    expect(check(report, 'server').status).toBe('warn');
    expect(report.ok).toBe(true);
  });

  it('warns when the settings file predates the current hook list', async () => {
    writeFileSync(
      join(dir, '.claude', 'settings.local.json'),
      JSON.stringify({
        hooks: {
          Stop: [{ hooks: [{ type: 'http', url: 'http://127.0.0.1:4300/hooks/Stop' }] }],
        },
      }),
      'utf8',
    );

    const report = await runDoctor({ cwd: dir, port: PORT, dbPath });
    expect(check(report, 'hook configuration').status).toBe('warn');
    expect(check(report, 'hook configuration').detail).toContain('out of date');
  });

  it('fails on a settings file that is not valid JSON', async () => {
    writeFileSync(join(dir, '.claude', 'settings.local.json'), '{ broken', 'utf8');

    const report = await runDoctor({ cwd: dir, port: PORT, dbPath });
    expect(check(report, 'hook configuration').status).toBe('fail');
    expect(report.ok).toBe(false);
  });
});

describe('hooks pointing at another board', () => {
  beforeEach(() => {
    runInit({ ...initBase, cwd: dir, baseUrl: 'http://127.0.0.1:4300' });
  });

  it('names both ports rather than reporting each half as fine', async () => {
    const report = await runDoctor({ cwd: dir, port: PORT, dbPath });
    const target = check(report, 'hook target');

    // Individually both halves are correct: every hook is registered, and the
    // server is where it was asked to be. Every event is dropped in between.
    expect(target.detail).toContain('4300');
    expect(target.detail).toContain(String(PORT));
  });

  it('warns while nothing is listening, since the port is a guess', async () => {
    const report = await runDoctor({ cwd: dir, port: PORT, dbPath });

    expect(check(report, 'hook target').status).toBe('warn');
    expect(report.ok).toBe(true);
  });

  it('fails once a board is confirmed on the other port', async () => {
    server = await startServer({ port: PORT, dbPath, logger: false });

    const report = await runDoctor({ cwd: dir, port: PORT, dbPath });

    // Now it is observed rather than supposed: there is a board here, and the
    // hooks are talking to somewhere else. Nothing else in the report matters.
    expect(check(report, 'hook target').status).toBe('fail');
    expect(report.ok).toBe(false);
  });

  it('does not call a matching configuration out of date', async () => {
    // The hooks are complete; they simply name another board. Sending the
    // operator to `init` would answer a question nobody asked.
    expect(
      check(await runDoctor({ cwd: dir, port: PORT, dbPath }), 'hook configuration').status,
    ).toBe('ok');
  });
});

describe('a running server', () => {
  beforeEach(async () => {
    runInit({ ...initBase, cwd: dir });
    server = await startServer({ port: PORT, dbPath, logger: false });
  });

  it('recognises Gorilla on the port', async () => {
    const report = await runDoctor({ cwd: dir, port: PORT, dbPath });

    expect(check(report, 'server').status).toBe('ok');
    expect(check(report, 'server').detail).toContain('serving');
    expect(report.ok).toBe(true);
  });
});

describe('delivery reporting', () => {
  beforeEach(() => {
    runInit({ ...initBase, cwd: dir });
  });

  it('names every hook that has not delivered', async () => {
    seedEvents(['Stop', 'PostToolUse']);

    const report = await runDoctor({ cwd: dir, port: PORT, dbPath });
    const silent = check(report, 'silent hooks');

    // Parsed rather than substring-matched: 'PostToolUse' is a substring of
    // 'PostToolUseFailure', so a naive contains check passes either way.
    const named = silent.detail.split(': ')[1]?.split(', ') ?? [];

    expect(silent.status).toBe('warn');
    expect(named).toContain('PreCompact');
    expect(named).not.toContain('PostToolUse');
    expect(named).not.toContain('Stop');
    expect(named).toContain('PostToolUseFailure');
  });

  it('reports all hooks healthy when every one has delivered', async () => {
    seedEvents(HOOK_DEFINITIONS.map((d) => d.event));

    const report = await runDoctor({ cwd: dir, port: PORT, dbPath });
    expect(check(report, 'silent hooks').status).toBe('ok');
    expect(check(report, 'event deliveries').detail).toContain(String(HOOK_DEFINITIONS.length));
  });

  it('treats an old delivery as silence', async () => {
    const twoDaysAgo = Date.now() - 48 * 60 * 60 * 1000;
    seedEvents(
      HOOK_DEFINITIONS.map((d) => d.event),
      twoDaysAgo,
    );

    const report = await runDoctor({ cwd: dir, port: PORT, dbPath });
    expect(check(report, 'silent hooks').status).toBe('warn');
  });

  it('reports the database location and size', async () => {
    seedEvents(['Stop']);

    const report = await runDoctor({ cwd: dir, port: PORT, dbPath });
    const database = check(report, 'database');

    expect(database.detail).toContain(dbPath);
    expect(database.detail).toMatch(/MB/);
  });

  it('does not fail before any event has arrived', async () => {
    const report = await runDoctor({ cwd: dir, port: PORT, dbPath });
    expect(check(report, 'event deliveries').status).toBe('warn');
    expect(report.ok).toBe(true);
  });
});

describe('transcript drift reporting', () => {
  beforeEach(() => {
    runInit({ ...initBase, cwd: dir });
  });

  it('reports unrecognised record types as a warning, not a failure', async () => {
    writeFileSync(
      join(dir, 'transcript.jsonl'),
      [
        JSON.stringify({ type: 'user', message: { content: 'hi' } }),
        JSON.stringify({ type: 'invented-later', payload: {} }),
      ].join('\n'),
      'utf8',
    );
    seedEvents(['Stop']);

    const report = await runDoctor({ cwd: dir, port: PORT, dbPath });
    const transcript = check(report, 'transcript format');

    expect(transcript.status).toBe('warn');
    expect(transcript.detail).toContain('invented-later');
    // Drift must not fail the run: the transcript is enrichment only.
    expect(report.ok).toBe(true);
  });

  it('reports a clean parse', async () => {
    writeFileSync(
      join(dir, 'transcript.jsonl'),
      JSON.stringify({ type: 'user', message: { content: 'hi' } }),
      'utf8',
    );
    seedEvents(['Stop']);

    const report = await runDoctor({ cwd: dir, port: PORT, dbPath });
    expect(check(report, 'transcript format').status).toBe('ok');
  });

  it('warns when the recorded transcript has since been deleted', async () => {
    seedEvents(['Stop']);

    const report = await runDoctor({ cwd: dir, port: PORT, dbPath });
    expect(check(report, 'transcript format').status).toBe('warn');
    expect(report.ok).toBe(true);
  });
});

describe('formatReport', () => {
  it('renders one line per check', async () => {
    runInit({ ...initBase, cwd: dir });
    seedEvents(['Stop']);

    const output = formatReport(await runDoctor({ cwd: dir, port: PORT, dbPath }));

    expect(output).toContain('[ok  ] hook configuration:');
    expect(output).toContain('[warn]');
    expect(output.split('\n').length).toBeGreaterThan(4);
  });
});

describe('boards that are really worktrees', () => {
  it('reports the ones registered before this was fixed', async () => {
    const handle = openDatabase({ path: join(dir, 'phantom.db') });
    handle.db.insert(boards).values({ id: 'real', name: 'project', cwd: dir, createdAt: 1 }).run();
    handle.db
      .insert(boards)
      .values({
        id: 'phantom',
        name: 'card-1',
        cwd: join(dir, '.gorilla/worktrees/card-1'),
        createdAt: 1,
      })
      .run();
    handle.close();

    const report = await runDoctor({ cwd: dir, port: PORT, dbPath: join(dir, 'phantom.db') });
    const check = report.checks.find((entry) => entry.name === 'boards');

    expect(check?.status).toBe('warn');
    expect(check?.detail).toContain('card-1');
  });

  it('does not offer to remove them', async () => {
    const handle = openDatabase({ path: join(dir, 'phantom.db') });
    handle.db
      .insert(boards)
      .values({
        id: 'phantom',
        name: 'card-1',
        cwd: join(dir, '.gorilla/worktrees/card-1'),
        createdAt: 1,
      })
      .run();
    handle.close();

    const report = await runDoctor({ cwd: dir, port: PORT, dbPath: join(dir, 'phantom.db') });
    const check = report.checks.find((entry) => entry.name === 'boards');

    // Those rows have runs and events hanging off them. A cleanup that got the
    // reattachment wrong would move one card's history onto another, which is
    // worse than a board list with junk in it.
    expect(check?.detail).toContain('Nothing removes them automatically');
  });
});
