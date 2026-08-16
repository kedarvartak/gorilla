import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '../src/server/app.js';
import { openDatabase, type DatabaseHandle } from '../src/server/db/client.js';
import { FixtureRecorder, readFixture } from '../src/server/fixtures/recorder.js';
import { redactPayload } from '../src/server/fixtures/redact.js';
import { replayEntries, replayFixture } from '../src/server/fixtures/replay.js';
import { startServer, type RunningServer } from '../src/server/start.js';
import { HOOK_DEFINITIONS } from '../src/hooks/definitions.js';

let dir: string;

const SESSION = '99999999-8888-4777-8666-555555555555';
const CWD = '/home/example/project';

function payloadFor(event: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    session_id: SESSION,
    hook_event_name: event,
    cwd: CWD,
    transcript_path: `/home/example/.claude/projects/slug/${SESSION}.jsonl`,
    ...extra,
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gorilla-fixtures-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('redactPayload', () => {
  it('destroys content while preserving structure and identifiers', () => {
    const redacted = redactPayload({
      session_id: SESSION,
      tool_name: 'Edit',
      tool_use_id: 'toolu_1',
      cwd: CWD,
      tool_input: {
        file_path: '/src/secret.ts',
        old_string: 'const apiKey = "sk-live-abcdef"',
        new_string: 'const apiKey = process.env.API_KEY',
      },
      tool_response: { stdout: 'AWS_SECRET=hunter2', stderr: '' },
    }) as Record<string, Record<string, string>>;

    expect(redacted['session_id']).toBe(SESSION);
    expect(redacted['tool_name']).toBe('Edit');
    expect(redacted['cwd']).toBe(CWD);
    // Paths are structure and survive; contents do not.
    expect(redacted['tool_input']?.['file_path']).toBe('/src/secret.ts');

    const serialised = JSON.stringify(redacted);
    expect(serialised).not.toContain('sk-live-abcdef');
    expect(serialised).not.toContain('hunter2');
    expect(redacted['tool_input']?.['old_string']).toMatch(/^\[redacted \d+ chars\]$/);
  });

  it('redacts nested and arrayed content', () => {
    const redacted = redactPayload({
      edits: [{ old_string: 'secret one' }, { old_string: 'secret two' }],
      deep: { deeper: { content: 'secret three' } },
    });

    const serialised = JSON.stringify(redacted);
    expect(serialised).not.toContain('secret one');
    expect(serialised).not.toContain('secret two');
    expect(serialised).not.toContain('secret three');
  });

  it('redacts the prompt and the assistant message', () => {
    const redacted = JSON.stringify(
      redactPayload({
        user_input: 'deploy using token ghp_realtoken',
        last_assistant_message: 'I used ghp_realtoken',
      }),
    );
    expect(redacted).not.toContain('ghp_realtoken');
  });

  it('leaves non-objects alone', () => {
    expect(redactPayload('plain')).toBe('plain');
    expect(redactPayload(null)).toBeNull();
  });
});

describe('FixtureRecorder', () => {
  it('records arrival order and relative timing', () => {
    const path = join(dir, 'rec.jsonl');
    const recorder = new FixtureRecorder({ path });

    recorder.record('SessionStart', payloadFor('SessionStart'), 1_000);
    recorder.record('PreToolUse', payloadFor('PreToolUse'), 1_250);
    recorder.record('Stop', payloadFor('Stop'), 3_000);

    const entries = readFixture(path);
    expect(entries.map((e) => e.event)).toEqual(['SessionStart', 'PreToolUse', 'Stop']);
    expect(entries.map((e) => e.t)).toEqual([0, 250, 2_000]);
    expect(recorder.count).toBe(3);
  });

  it('redacts by default', () => {
    const path = join(dir, 'rec.jsonl');
    new FixtureRecorder({ path }).record(
      'PostToolUse',
      payloadFor('PostToolUse', { tool_response: { stdout: 'TOP_SECRET' } }),
    );

    expect(readFileSync(path, 'utf8')).not.toContain('TOP_SECRET');
  });

  it('can be told not to redact', () => {
    const path = join(dir, 'raw.jsonl');
    new FixtureRecorder({ path, redact: false }).record(
      'PostToolUse',
      payloadFor('PostToolUse', { tool_response: { stdout: 'KEEP_ME' } }),
    );

    expect(readFileSync(path, 'utf8')).toContain('KEEP_ME');
  });

  it('skips unparseable lines when reading rather than failing', () => {
    const path = join(dir, 'damaged.jsonl');
    writeFileSync(
      path,
      [
        JSON.stringify({ t: 0, event: 'Stop', payload: {} }),
        'not json',
        JSON.stringify({ t: 1, missing: 'event name' }),
        JSON.stringify({ t: 2, event: 'SessionEnd', payload: {} }),
      ].join('\n'),
    );

    expect(readFixture(path).map((e) => e.event)).toEqual(['Stop', 'SessionEnd']);
  });

  it('throws a clear error for a missing fixture', () => {
    expect(() => readFixture(join(dir, 'absent.jsonl'))).toThrow(/Fixture not found/);
  });
});

describe('record then replay', () => {
  let server: RunningServer;
  let recordingDb: DatabaseHandle;

  afterEach(async () => {
    await server?.stop();
    recordingDb?.close();
  });

  it('reproduces an identical event set in a clean database', async () => {
    // Phase one: record. Drive a server with the recorder attached.
    const fixturePath = join(dir, 'session.jsonl');
    const recorder = new FixtureRecorder({ path: fixturePath });
    recordingDb = openDatabase({ path: join(dir, 'record.db') });
    const recordingApp = buildApp({ database: recordingDb, logger: false, recorder });
    await recordingApp.ready();

    for (const definition of HOOK_DEFINITIONS) {
      await recordingApp.inject({
        method: 'POST',
        url: `/hooks/${definition.event}`,
        payload: payloadFor(definition.event, { tool_name: 'Edit', secret: 'do-not-leak' }),
      });
    }
    await recordingApp.close();

    const recorded = recordingDb.sqlite
      .prepare('SELECT seq, event_name FROM events ORDER BY seq')
      .all() as { seq: number; event_name: string }[];
    expect(recorded).toHaveLength(HOOK_DEFINITIONS.length);

    // Phase two: replay into a genuinely separate server over real HTTP.
    server = await startServer({ port: 4457, dbPath: join(dir, 'replay.db'), logger: false });
    const result = await replayFixture(fixturePath, { url: server.url });

    expect(result.failed).toBe(0);
    expect(result.sent).toBe(HOOK_DEFINITIONS.length);

    const replayed = server.database.sqlite
      .prepare('SELECT seq, event_name FROM events ORDER BY seq')
      .all() as { seq: number; event_name: string }[];

    // The comparison the goal condition asks for: identical event sets.
    expect(replayed).toEqual(recorded);
  });

  it('preserves count and ordering when redacted', async () => {
    const fixturePath = join(dir, 'redacted.jsonl');
    const recorder = new FixtureRecorder({ path: fixturePath, redact: true });

    recorder.record(
      'PostToolUse',
      payloadFor('PostToolUse', { tool_response: { stdout: 'SENSITIVE_OUTPUT' } }),
    );
    recorder.record('Stop', payloadFor('Stop', { last_assistant_message: 'SENSITIVE_SUMMARY' }));

    expect(readFileSync(fixturePath, 'utf8')).not.toMatch(/SENSITIVE_(OUTPUT|SUMMARY)/);

    server = await startServer({ port: 4458, dbPath: join(dir, 'r2.db'), logger: false });
    const result = await replayFixture(fixturePath, { url: server.url });

    expect(result.sent).toBe(2);
    const rows = server.database.sqlite
      .prepare('SELECT event_name FROM events ORDER BY seq')
      .all() as { event_name: string }[];
    expect(rows.map((r) => r.event_name)).toEqual(['PostToolUse', 'Stop']);
  });

  it('reports failures rather than throwing when nothing is listening', async () => {
    server = await startServer({ port: 4459, dbPath: join(dir, 'r3.db'), logger: false });

    const result = await replayEntries([{ t: 0, event: 'Stop', payload: payloadFor('Stop') }], {
      url: 'http://127.0.0.1:4999',
    });

    expect(result.sent).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.failures['Stop']).toBe(1);
  });

  it('honours original pacing', async () => {
    server = await startServer({ port: 4460, dbPath: join(dir, 'r4.db'), logger: false });

    const started = Date.now();
    const result = await replayEntries(
      [
        { t: 0, event: 'SessionStart', payload: payloadFor('SessionStart') },
        { t: 120, event: 'Stop', payload: payloadFor('Stop') },
      ],
      { url: server.url, pacing: 'original' },
    );

    expect(result.sent).toBe(2);
    expect(Date.now() - started).toBeGreaterThanOrEqual(100);
  });

  it('caps a long gap so replaying an overnight session is possible', async () => {
    server = await startServer({ port: 4461, dbPath: join(dir, 'r5.db'), logger: false });

    const started = Date.now();
    await replayEntries(
      [
        { t: 0, event: 'SessionStart', payload: payloadFor('SessionStart') },
        { t: 8 * 60 * 60 * 1000, event: 'Stop', payload: payloadFor('Stop') },
      ],
      { url: server.url, pacing: 'original', maxDelayMs: 50 },
    );

    expect(Date.now() - started).toBeLessThan(5_000);
  });
});
