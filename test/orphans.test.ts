import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createCard, updateCard } from '../src/server/api/cards.js';
import { createDefaultColumns } from '../src/server/cards/defaults.js';
import { openDatabase, type DatabaseHandle } from '../src/server/db/client.js';
import { boards, cards } from '../src/server/db/schema.js';
import { describeOrphans, findOrphans } from '../src/server/worktree/orphans.js';
import { eq } from 'drizzle-orm';

/**
 * Worktrees nothing is waiting on (T48).
 *
 * The backlog asked for a reaper. Doc 18 says why that is wrong: an unreviewed
 * worktree holds a night of an agent's work, and a scheduled remover would
 * eventually take the one that mattered, at 3am.
 */

let dir: string;
let handle: DatabaseHandle;
const BOARD = 'board-1';

function workspace(cardId: string) {
  return { cardId, path: `${dir}/.gorilla/worktrees/${cardId}`, branch: `gorilla/${cardId}` };
}

function card(title: string): string {
  return createCard(handle, { boardId: BOARD, title }).id;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gorilla-orphans-'));
  handle = openDatabase({ path: join(dir, 'o.db') });
  handle.db.insert(boards).values({ id: BOARD, name: 'b', cwd: dir, createdAt: 1 }).run();
  createDefaultColumns(handle.db, BOARD);
});

afterEach(() => {
  handle.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('finding them', () => {
  it('says nothing about a worktree with work still under review', () => {
    const id = card('still being reviewed');
    updateCard(handle, id, { status: 'awaiting-review' });

    // The whole point of keeping worktrees. Listing this one as removable is
    // how a night of work gets thrown away.
    expect(findOrphans(handle.sqlite, [workspace(id)])).toEqual([]);
  });

  it('finds one whose card was deleted', () => {
    const orphans = findOrphans(handle.sqlite, [workspace('no-such-card')]);

    // The only case with no argument on the other side: nothing can review it
    // and nothing ever will.
    expect(orphans[0]?.reason).toBe('no-card');
    expect(orphans[0]?.title).toBeNull();
  });

  it('finds one whose card merged', () => {
    const id = card('merged');
    handle.db.update(cards).set({ mergedAt: Date.now() }).where(eq(cards.id, id)).run();

    expect(findOrphans(handle.sqlite, [workspace(id)])[0]?.reason).toBe('merged');
  });

  it('finds one whose card was abandoned', () => {
    const id = card('abandoned');
    updateCard(handle, id, { status: 'abandoned' });

    // The operator has already decided this work is not happening.
    expect(findOrphans(handle.sqlite, [workspace(id)])[0]?.reason).toBe('abandoned');
  });

  it('says nothing when there are no worktrees at all', () => {
    expect(findOrphans(handle.sqlite, [])).toEqual([]);
  });
});

describe('how it is said', () => {
  it('states that nothing is removed automatically', () => {
    const note = describeOrphans(findOrphans(handle.sqlite, [workspace('no-such-card')]));

    // An operator who reads a list of removable things and assumes the board
    // is handling it will find the disks full and the board blameless.
    expect(note).toContain('Nothing removes them automatically');
  });

  it('says why each one is removable', () => {
    const id = card('merged');
    handle.db.update(cards).set({ mergedAt: Date.now() }).where(eq(cards.id, id)).run();

    // A merged card's leftover and a deleted card's orphan are different
    // decisions for whoever is about to press remove.
    expect(describeOrphans(findOrphans(handle.sqlite, [workspace(id)]))).toContain(
      'the card merged',
    );
  });

  it('says nothing when there is nothing to say', () => {
    expect(describeOrphans([])).toBeNull();
  });
});
