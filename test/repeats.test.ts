import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDatabase, type DatabaseHandle } from '../src/server/db/client.js';
import { boards, runs } from '../src/server/db/schema.js';
import { describeRepeats, MIN_REPEATS, repeatsIn } from '../src/server/timeline/repeats.js';

/**
 * The same thing failing over and over (T33).
 *
 * A run refused a tool does not stop. It tries again, usually with the same
 * call, sometimes eighty times, and the timeline renders eighty rows that each
 * look like work.
 */

let dir: string;
let handle: DatabaseHandle;
let runId: string;
let seq = 0;

function event(name: string, payload: Record<string, unknown>): void {
  seq += 1;
  handle.sqlite
    .prepare(
      'INSERT INTO events (run_id, session_id, seq, event_name, received_at, payload) VALUES (?,?,?,?,?,?)',
    )
    .run(runId, 'sess', seq, name, Date.now() + seq, JSON.stringify(payload));
}

function asked(id: string, tool: string, path?: string): void {
  event('PreToolUse', {
    tool_use_id: id,
    tool_name: tool,
    ...(path === undefined ? {} : { tool_input: { file_path: path } }),
  });
}

function answered(id: string, tool: string): void {
  event('PostToolUse', { tool_use_id: id, tool_name: tool });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gorilla-repeats-'));
  handle = openDatabase({ path: join(dir, 'r.db') });
  handle.db.insert(boards).values({ id: 'b', name: 'b', cwd: dir, createdAt: 1 }).run();

  runId = randomUUID();
  seq = 0;
  handle.db
    .insert(runs)
    .values({ id: runId, boardId: 'b', sessionId: 'sess', startedAt: 1, cwd: dir })
    .run();
});

afterEach(() => {
  handle.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('finding what repeated', () => {
  it('groups the same unanswered call', () => {
    for (let index = 0; index < 5; index += 1) asked(`id-${String(index)}`, 'Bash', 'npm test');

    const repeats = repeatsIn(handle.sqlite, runId);

    expect(repeats[0]?.count).toBe(5);
    expect(repeats[0]?.tool).toBe('Bash');
  });

  it('ignores calls that were answered', () => {
    for (let index = 0; index < 5; index += 1) {
      const id = `id-${String(index)}`;
      asked(id, 'Bash', 'npm test');
      answered(id, 'Bash');
    }

    // Five calls that worked are five pieces of work, not a storm.
    expect(repeatsIn(handle.sqlite, runId)).toEqual([]);
  });

  it('says nothing about one or two tries', () => {
    asked('a', 'Bash', 'npm test');
    asked('b', 'Bash', 'npm test');

    // Two of anything is a retry. Three is a pattern.
    expect(repeatsIn(handle.sqlite, runId)).toEqual([]);
    expect(MIN_REPEATS).toBe(3);
  });

  it('keeps different targets apart', () => {
    for (let index = 0; index < 3; index += 1) asked(`a-${String(index)}`, 'Edit', 'one.ts');
    for (let index = 0; index < 4; index += 1) asked(`b-${String(index)}`, 'Edit', 'two.ts');

    const repeats = repeatsIn(handle.sqlite, runId);

    expect(repeats).toHaveLength(2);
    expect(repeats[0]?.target).toBe('two.ts');
  });

  it('skips a call with no id rather than guessing', () => {
    for (let index = 0; index < 5; index += 1) event('PreToolUse', { tool_name: 'Bash' });

    // Without an id there is no way to pair a request with its outcome, so it
    // cannot be shown to have gone unanswered.
    expect(repeatsIn(handle.sqlite, runId)).toEqual([]);
  });

  it('has nothing to say about a run with no tool calls', () => {
    event('SessionStart', {});

    expect(repeatsIn(handle.sqlite, runId)).toEqual([]);
  });
});

describe('how it is said', () => {
  it('says unanswered rather than denied', () => {
    for (let index = 0; index < 4; index += 1) asked(`id-${String(index)}`, 'Bash', 'npm test');

    // A call goes unanswered when it is refused, and also when the run was
    // killed mid-call. The board cannot tell those apart from here.
    const note = describeRepeats(repeatsIn(handle.sqlite, runId));
    expect(note).toContain('never answered');
    expect(note).toContain('Usually a denied permission');
  });

  it('counts the others without listing them', () => {
    for (let index = 0; index < 4; index += 1) asked(`a-${String(index)}`, 'Edit', 'one.ts');
    for (let index = 0; index < 3; index += 1) asked(`b-${String(index)}`, 'Edit', 'two.ts');

    expect(describeRepeats(repeatsIn(handle.sqlite, runId))).toContain('1 other repeated call');
  });

  it('says nothing when nothing repeated', () => {
    expect(describeRepeats([])).toBeNull();
  });
});
