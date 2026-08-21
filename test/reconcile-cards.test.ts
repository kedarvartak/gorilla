import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createCard, getCard, updateCard } from '../src/server/api/cards.js';
import { createDefaultColumns } from '../src/server/cards/defaults.js';
import { openDatabase, type DatabaseHandle } from '../src/server/db/client.js';
import { boards } from '../src/server/db/schema.js';
import { describeCardReconcile, reconcileRunningCards } from '../src/server/cards/reconcile.js';

/**
 * Cards left running when the board stopped (T47).
 *
 * Dispatch is in-process, so a card found in `running` at startup has nothing
 * supervising it and nothing that ever will. The board has already been bitten
 * by the softer version of this - a run that read as in progress for
 * twenty-five hours - and this version never resolves on its own.
 */

let dir: string;
let handle: DatabaseHandle;
const BOARD = 'board-1';

function card(title: string, status: 'idle' | 'running' | 'awaiting-review'): string {
  const created = createCard(handle, { boardId: BOARD, title });
  if (status !== 'idle') updateCard(handle, created.id, { status });
  return created.id;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gorilla-reconcile-'));
  handle = openDatabase({ path: join(dir, 'r.db') });
  handle.db.insert(boards).values({ id: BOARD, name: 'b', cwd: dir, createdAt: 1 }).run();
  createDefaultColumns(handle.db, BOARD);
});

afterEach(() => {
  handle.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('a card that was running when the board stopped', () => {
  it('is moved to blocked', () => {
    const id = card('cut off', 'running');

    reconcileRunningCards(handle.sqlite, Date.now());

    // Blocked, not idle. The card has a worktree with whatever the run managed
    // to do, and requeueing would start a second run on top of it.
    expect(getCard(handle, id).status).toBe('blocked');
  });

  it('is not called abandoned', () => {
    const id = card('cut off', 'running');

    reconcileRunningCards(handle.sqlite, Date.now());

    // Nobody abandoned it. The board did this to it.
    expect(getCard(handle, id).status).not.toBe('abandoned');
  });

  it('leaves every other card alone', () => {
    const idle = card('waiting', 'idle');
    const reviewing = card('finished', 'awaiting-review');

    reconcileRunningCards(handle.sqlite, Date.now());

    expect(getCard(handle, idle).status).toBe('idle');
    expect(getCard(handle, reviewing).status).toBe('awaiting-review');
  });

  it('reports nothing when there was nothing to correct', () => {
    card('waiting', 'idle');

    const result = reconcileRunningCards(handle.sqlite, Date.now());

    expect(result.interrupted).toEqual([]);
    expect(describeCardReconcile(result)).toBeNull();
  });

  it('names the cards rather than counting them', () => {
    card('the interrupted one', 'running');

    const note = describeCardReconcile(reconcileRunningCards(handle.sqlite, Date.now()));

    // A count says something was interrupted. The name says which branch to go
    // and look at, which is the next thing the operator does anyway.
    expect(note).toContain('the interrupted one');
    expect(note).toContain('still on their branches');
  });

  it('is idempotent, because a restart loop must not keep reporting it', () => {
    card('cut off', 'running');

    expect(reconcileRunningCards(handle.sqlite, Date.now()).interrupted).toHaveLength(1);
    expect(reconcileRunningCards(handle.sqlite, Date.now()).interrupted).toHaveLength(0);
  });
});
