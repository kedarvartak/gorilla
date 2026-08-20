import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDatabase, type DatabaseHandle } from '../src/server/db/client.js';
import { boards, events, runs } from '../src/server/db/schema.js';
import {
  BACKFILLED,
  backfillFromTranscripts,
  describeBackfill,
} from '../src/server/transcript/backfill.js';
import { transcriptDirForCwd } from '../src/server/transcript/locate.js';

/**
 * Recovering sessions that ran before the board existed (doc 06).
 *
 * The assertions that matter are about restraint. A transcript is not an event
 * stream, and a reconstructed history that quietly claims more fidelity than it
 * has is worse than an empty board - the empty board at least tells the truth.
 */

let dir: string;
let home: string;
let project: string;
let handle: DatabaseHandle;
const BOARD = 'board-1';

/** A transcript where Claude Code would have written one. */
function transcript(sessionId: string, records: string[]): void {
  const target = transcriptDirForCwd(project, home);
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, `${sessionId}.jsonl`), records.join('\n') + '\n');
}

const assistantRecord = (text: string): string =>
  JSON.stringify({
    type: 'assistant',
    uuid: 'u1',
    timestamp: '2026-08-01T10:00:00Z',
    gitBranch: 'main',
    cwd: '/proj',
    message: {
      model: 'claude-sonnet-5',
      content: [{ type: 'text', text }],
      usage: { input_tokens: 100, output_tokens: 40 },
    },
  });

// Claude Code puts the branch and directory on user records, not assistant
// ones, so that is where the reader looks for them.
const userRecord = (text: string): string =>
  JSON.stringify({
    type: 'user',
    uuid: 'u0',
    gitBranch: 'main',
    cwd: '/proj',
    message: { content: text },
  });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gorilla-backfill-'));
  home = join(dir, 'home');
  project = join(dir, 'project');
  mkdirSync(project, { recursive: true });

  handle = openDatabase({ path: join(dir, 'backfill.db') });
  handle.db.insert(boards).values({ id: BOARD, name: 't', cwd: project, createdAt: 1 }).run();
});

afterEach(() => {
  handle.close();
  rmSync(dir, { recursive: true, force: true });
});

const run = () => backfillFromTranscripts({ handle, boardId: BOARD, cwd: project, home });

describe('recovering what is there', () => {
  it('creates a run for a session the board never saw', async () => {
    transcript('session-a', [userRecord('do the thing'), assistantRecord('done')]);

    const result = await run();

    expect(result.runsAdded).toBe(1);
    const stored = handle.db.select().from(runs).all();
    expect(stored[0]?.sessionId).toBe('session-a');
    expect(stored[0]?.model).toBe('claude-sonnet-5');
    expect(stored[0]?.gitBranch).toBe('main');
  });

  it('marks the run as reconstructed rather than watched', async () => {
    transcript('session-a', [userRecord('go'), assistantRecord('hello')]);
    await run();

    const stored = handle.db.select().from(runs).all()[0];

    // A history dressed up as a live one would be the board claiming fidelity
    // it does not have.
    expect(stored?.endReason).toBe(BACKFILLED);
    // And closed on arrival: a run recovered from a file is not in progress.
    expect(stored?.endedAt).not.toBeNull();
  });

  it('leaves the run unbound to any card', async () => {
    transcript('session-a', [assistantRecord('hello')]);
    await run();

    // Attributing reconstructed history to a card would be inventing a link
    // nobody drew. Doc 05 already treats an unbound run as legitimate.
    expect(handle.db.select().from(runs).all()[0]?.cardId).toBeNull();
  });

  it('writes one honest event rather than a fabricated timeline', async () => {
    transcript('session-a', [userRecord('go'), assistantRecord('done')]);
    await run();

    const stored = handle.db.select().from(events).all();
    expect(stored).toHaveLength(1);
    expect(stored[0]?.eventName).toBe('SessionEnd');

    // Everything downstream treats events as evidence, so inventing tool calls
    // from assistant prose would poison the ledger with guesses.
    const payload = JSON.parse(stored[0]?.payload ?? '{}') as {
      _gorilla_backfill?: { note: string };
    };
    expect(payload._gorilla_backfill?.note).toContain('no tool events exist');
  });
});

describe('not making things worse', () => {
  it('skips a session the board already recorded', async () => {
    handle.db
      .insert(runs)
      .values({
        id: 'existing',
        boardId: BOARD,
        sessionId: 'session-a',
        cwd: project,
        startedAt: 1,
      })
      .run();

    transcript('session-a', [assistantRecord('hello')]);
    const result = await run();

    // Re-reading a live-recorded session could only produce a worse version of
    // what the hooks captured at the time.
    expect(result.runsAdded).toBe(0);
    expect(result.alreadyKnown).toBe(1);
    expect(handle.db.select().from(runs).all()).toHaveLength(1);
  });

  it('is safe to run twice', async () => {
    transcript('session-a', [assistantRecord('hello')]);
    await run();
    const second = await run();

    expect(second.runsAdded).toBe(0);
    expect(handle.db.select().from(runs).all()).toHaveLength(1);
  });

  it('names a transcript it could not read rather than counting it', async () => {
    transcript('session-a', [assistantRecord('hello')]);
    const result = await backfillFromTranscripts({
      handle,
      boardId: BOARD,
      cwd: project,
      home,
      maxBytes: 1,
    });

    expect(result.runsAdded).toBe(0);
    expect(result.unreadable[0]).toContain('too large');
  });

  it('says nothing was found rather than reporting success', async () => {
    const result = await run();

    expect(result.transcriptsSeen).toBe(0);
    expect(describeBackfill(result)[0]).toContain('Nothing to recover');
  });
});

describe('what it tells the operator', () => {
  it('states the limitation every time it recovers anything', async () => {
    transcript('session-a', [assistantRecord('hello')]);
    const lines = describeBackfill(await run()).join('\n');

    // The limitation is the point: these runs carry when and how much, and
    // nothing about what was decided.
    expect(lines).toContain('1 recovered');
    expect(lines).toContain('no tool events');
  });
});
