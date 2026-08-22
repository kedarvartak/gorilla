import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { fixtureCommand } from '../src/cli/commands/fixture.js';
import { openDatabase, type DatabaseHandle } from '../src/server/db/client.js';
import { boards, runs } from '../src/server/db/schema.js';
import { fixtureFromRun, renderFixture } from '../src/server/fixtures/from-run.js';

/**
 * Making a fixture out of a run that already happened (T66).
 *
 * The recorder only captures what it was running for. In practice the
 * interesting thing is a dispatch bug found afterwards, in a run nobody was
 * recording, and it gets described in a card instead of reproduced.
 */

let dir: string;
let dbPath: string;
let handle: DatabaseHandle;
const BOARD = 'board-1';
let runId: string;

function event(name: string, receivedAt: number, payload: unknown, seq: number): void {
  handle.sqlite
    .prepare(
      'INSERT INTO events (run_id, session_id, seq, event_name, received_at, payload) VALUES (?,?,?,?,?,?)',
    )
    .run(runId, 'sess', seq, name, receivedAt, JSON.stringify(payload));
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gorilla-fixture-'));
  dbPath = join(dir, 'f.db');
  handle = openDatabase({ path: dbPath });
  handle.db.insert(boards).values({ id: BOARD, name: 'b', cwd: dir, createdAt: 1 }).run();

  runId = randomUUID();
  handle.db
    .insert(runs)
    .values({ id: runId, boardId: BOARD, sessionId: 'sess', startedAt: 1_000, cwd: dir })
    .run();
});

afterEach(() => {
  handle.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('reading a run back out', () => {
  it('keeps the pacing, relative to the first event', () => {
    event('SessionStart', 10_000, {}, 1);
    event('PreToolUse', 12_500, {}, 2);

    // Absolute timestamps would replay a two-year-old run as though it were
    // happening in 2024. Relative ones reproduce the gap, which is the part
    // that matters for a timing bug.
    expect(fixtureFromRun(handle.sqlite, runId).entries.map((entry) => entry.t)).toEqual([
      0, 2_500,
    ]);
  });

  it('keeps the order the events arrived in', () => {
    event('SessionStart', 10_000, {}, 1);
    event('Stop', 11_000, {}, 2);

    expect(fixtureFromRun(handle.sqlite, runId).entries.map((entry) => entry.event)).toEqual([
      'SessionStart',
      'Stop',
    ]);
  });

  it('redacts what the live recorder would have redacted', () => {
    event('PreToolUse', 10_000, { env: { ANTHROPIC_API_KEY: 'sk-ant-secret-value' } }, 1);

    const rendered = renderFixture(fixtureFromRun(handle.sqlite, runId));

    // A fixture is a file people commit.
    expect(rendered).not.toContain('sk-ant-secret-value');
  });

  it('answers empty for a run with no events', () => {
    expect(fixtureFromRun(handle.sqlite, runId).count).toBe(0);
  });

  it('renders one object per line, as replay reads it', () => {
    event('SessionStart', 10_000, {}, 1);
    event('Stop', 11_000, {}, 2);

    const lines = renderFixture(fixtureFromRun(handle.sqlite, runId)).trim().split('\n');

    expect(lines).toHaveLength(2);
    expect(() => JSON.parse(lines[0] ?? '')).not.toThrow();
  });
});

describe('the command', () => {
  it('writes the file and says how to replay it', async () => {
    event('SessionStart', 10_000, {}, 1);
    const out = join(dir, 'run.jsonl');

    const result = await fixtureCommand.run([runId, '--db', dbPath, '--out', out]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('gorilla replay');
    expect(readFileSync(out, 'utf8')).toContain('SessionStart');
  });

  it('warns that the file carries what the run read', async () => {
    event('SessionStart', 10_000, {}, 1);

    const result = await fixtureCommand.run([runId, '--db', dbPath, '--out', join(dir, 'r.jsonl')]);

    // Credentials are redacted, but what a run reads is source code.
    expect(result.stdout).toContain('Read it before committing it');
  });

  it('refuses rather than writing an empty file', async () => {
    const result = await fixtureCommand.run([runId, '--db', dbPath, '--out', join(dir, 'r.jsonl')]);

    // A zero-byte fixture replays silently and looks like a run that did
    // nothing.
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('No events are recorded');
  });

  it('asks for a run when none was named', async () => {
    expect((await fixtureCommand.run(['--db', dbPath])).stderr).toContain('gorilla fixture');
  });
});
