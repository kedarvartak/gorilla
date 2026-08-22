import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createCard } from '../src/server/api/cards.js';
import { createDefaultColumns } from '../src/server/cards/defaults.js';
import { openDatabase, type DatabaseHandle } from '../src/server/db/client.js';
import { boards, runs } from '../src/server/db/schema.js';
import { INTERRUPTED } from '../src/server/ingest/lifecycle.js';
import { describeResume, resumableFor } from '../src/server/dispatch/resume.js';
import { buildArgs } from '../src/server/launcher/args.js';
import { EMPTY_GUARDRAILS } from '../src/server/cards/guardrails.js';

/**
 * Picking up a run that was cut off (T46).
 *
 * The launcher has been able to pass `--resume` since it was written and
 * nothing ever set it, so an interrupted card began from nothing: the worktree
 * survived and the reasoning that produced it did not.
 */

let dir: string;
let handle: DatabaseHandle;
const BOARD = 'board-1';

function card(title: string): string {
  return createCard(handle, { boardId: BOARD, title }).id;
}

function run(
  cardId: string,
  options: { endReason?: string | null; startedAt?: number; sessionId?: string } = {},
): string {
  const sessionId = options.sessionId ?? randomUUID();
  handle.db
    .insert(runs)
    .values({
      id: randomUUID(),
      boardId: BOARD,
      cardId,
      sessionId,
      startedAt: options.startedAt ?? Date.now(),
      ...(options.endReason === undefined ? {} : { endReason: options.endReason }),
      cwd: dir,
    })
    .run();
  return sessionId;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gorilla-resume-'));
  handle = openDatabase({ path: join(dir, 'r.db') });
  handle.db.insert(boards).values({ id: BOARD, name: 'b', cwd: dir, createdAt: 1 }).run();
  createDefaultColumns(handle.db, BOARD);
});

afterEach(() => {
  handle.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('deciding whether to resume', () => {
  it('resumes a session the board recorded as cut off', () => {
    const id = card('interrupted');
    const sessionId = run(id, { endReason: INTERRUPTED });

    expect(resumableFor(handle.sqlite, id)?.sessionId).toBe(sessionId);
  });

  it('does not resume a run that ended on its own terms', () => {
    const id = card('finished');
    run(id, { endReason: 'session ended' });

    // Resuming would drop the agent back into the turn where it had already
    // decided it could not proceed, and it would decide that again at a cost.
    expect(resumableFor(handle.sqlite, id)).toBeNull();
  });

  it('does not resume once a later run has happened', () => {
    const id = card('moved on');
    run(id, { endReason: INTERRUPTED, startedAt: Date.now() - 10_000 });
    run(id, { startedAt: Date.now() });

    // Whatever the interrupted session knew has been superseded.
    expect(resumableFor(handle.sqlite, id)).toBeNull();
  });

  it('has nothing to resume for a card that never ran', () => {
    expect(resumableFor(handle.sqlite, card('never ran'))).toBeNull();
  });
});

describe('saying which happened', () => {
  it('names the session when resuming', () => {
    const id = card('interrupted');
    run(id, { endReason: INTERRUPTED });

    // A resumed run behaves differently from a fresh one, and the operator
    // reading the log should know which they got.
    expect(describeResume(resumableFor(handle.sqlite, id))).toContain('Resuming session');
  });

  it('says a fresh session is fresh', () => {
    expect(describeResume(null)).toBe('Starting a new session.');
  });
});

describe('what reaches the CLI', () => {
  it('passes --resume with the session', () => {
    const args = buildArgs({
      goalCondition: 'done when done',
      prompt: null,
      guardrails: EMPTY_GUARDRAILS,
      agentModel: null,
      agentEffort: null,
      permissionMode: null,
      contextFilePath: null,
      settingsPath: null,
      resumeSessionId: 'sess-1',
    });

    expect(args).toContain('--resume');
    expect(args[args.indexOf('--resume') + 1]).toBe('sess-1');
  });

  it('passes nothing when there is nothing to resume', () => {
    const args = buildArgs({
      goalCondition: 'done when done',
      prompt: null,
      guardrails: EMPTY_GUARDRAILS,
      agentModel: null,
      agentEffort: null,
      permissionMode: null,
      contextFilePath: null,
      settingsPath: null,
      resumeSessionId: null,
    });

    expect(args).not.toContain('--resume');
  });
});
