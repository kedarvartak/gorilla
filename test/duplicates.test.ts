import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createCard, updateCard } from '../src/server/api/cards.js';
import { createDefaultColumns } from '../src/server/cards/defaults.js';
import { describeDuplicates, findDuplicates } from '../src/server/cards/duplicates.js';
import { openDatabase, type DatabaseHandle } from '../src/server/db/client.js';
import { boards } from '../src/server/db/schema.js';

/**
 * Noticing a card that restates one already on the board (T53).
 *
 * Cards arrive from planning conversations in batches, and the same work gets
 * described twice with different words. Two cards for one piece of work is two
 * worktrees, two branches, and a merge conflict between an agent and itself.
 */

let dir: string;
let handle: DatabaseHandle;
const BOARD = 'board-1';

function card(title: string, status?: 'done' | 'abandoned'): string {
  const created = createCard(handle, { boardId: BOARD, title });
  if (status !== undefined) updateCard(handle, created.id, { status });
  return created.id;
}

function duplicatesOf(title: string) {
  return findDuplicates(handle.sqlite, BOARD, title);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gorilla-duplicates-'));
  handle = openDatabase({ path: join(dir, 'd.db') });
  handle.db.insert(boards).values({ id: BOARD, name: 'b', cwd: dir, createdAt: 1 }).run();
  createDefaultColumns(handle.db, BOARD);
});

afterEach(() => {
  handle.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('spotting a restatement', () => {
  it('matches the same work worded differently', () => {
    card('Warn when the hooks point somewhere the board is not');

    expect(duplicatesOf('Warn when hooks point where the board is not')).toHaveLength(1);
  });

  it('leaves unrelated cards alone', () => {
    card('Export a card brief as markdown');

    // A false warning on every card in a family the operator is already
    // working on is worse than a missed duplicate: they stop reading it.
    expect(duplicatesOf('Stop the queue when the budget is spent')).toEqual([]);
  });

  it('still warns about work already finished', () => {
    card('Record what a run cost', 'done');

    // Restating finished work is the mistake this exists to catch.
    expect(duplicatesOf('Record what a run costs')).toHaveLength(1);
  });

  it('says nothing about work the operator abandoned', () => {
    card('Record what a run cost', 'abandoned');

    // They already decided that work is not happening. Warning invites them to
    // un-decide it by accident.
    expect(duplicatesOf('Record what a run costs')).toEqual([]);
  });

  it('never matches the card being checked', () => {
    const id = card('Record what a run cost');

    expect(findDuplicates(handle.sqlite, BOARD, 'Record what a run cost', id)).toEqual([]);
  });

  it('reports how close it thought the match was', () => {
    card('Record what a run cost');

    // So the operator can judge a borderline one themselves rather than
    // trusting a threshold they cannot see.
    expect(duplicatesOf('Record what a run costs')[0]?.similarity).toBeGreaterThan(0.5);
  });

  it('says nothing for an empty title', () => {
    card('anything');
    expect(duplicatesOf('   ')).toEqual([]);
  });
});

describe('how it is said', () => {
  it('makes clear the card was added anyway', () => {
    card('Record what a run cost');
    const note = describeDuplicates(duplicatesOf('Record what a run costs'));

    // A refusal would be a board the operator learns to word their titles
    // around, which is worse than no check.
    expect(note).toContain('Added anyway');
  });

  it('says nothing when there is nothing to say', () => {
    expect(describeDuplicates([])).toBeNull();
  });
});
