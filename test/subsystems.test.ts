import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createCard } from '../src/server/api/cards.js';
import { createDefaultColumns } from '../src/server/cards/defaults.js';
import {
  cardsTouching,
  claimedButNotInGit,
  pathsForCard,
  recordCardPaths,
  subsystemOf,
  subsystemsForCard,
} from '../src/server/cards/subsystems.js';
import { openDatabase, type DatabaseHandle } from '../src/server/db/client.js';
import { boards } from '../src/server/db/schema.js';

/**
 * Which parts of the project a card touched (T13).
 *
 * Doc 12's project model needs to know two cards worked on the same thing.
 * Nothing recorded it, so every cross-card question had no data behind it.
 */

let dir: string;
let handle: DatabaseHandle;
const BOARD = 'board-1';

function card(title: string): string {
  return createCard(handle, { boardId: BOARD, title }).id;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gorilla-subsystems-'));
  handle = openDatabase({ path: join(dir, 's.db') });
  handle.db.insert(boards).values({ id: BOARD, name: 'b', cwd: dir, createdAt: 1 }).run();
  createDefaultColumns(handle.db, BOARD);
});

afterEach(() => {
  handle.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('grouping a path', () => {
  it('groups two levels deep', () => {
    // One level is useless in this shape of project - everything is `src`.
    expect(subsystemOf('src/server/dispatch/dispatcher.ts')).toBe('src/server');
    expect(subsystemOf('docs/20-backlog.md')).toBe('docs');
  });

  it('keeps a bare filename as itself', () => {
    expect(subsystemOf('package.json')).toBe('package.json');
  });
});

describe('recording what a card touched', () => {
  it('keeps git and the run’s own account apart', () => {
    const id = card('a card');
    recordCardPaths(handle.sqlite, id, ['src/a.ts'], 'git', 1);
    recordCardPaths(handle.sqlite, id, ['src/a.ts'], 'claimed', 1);

    // Merging them would lose the only comparison in the system that can catch
    // a run claiming work it did not do.
    expect(pathsForCard(handle.sqlite, id)).toEqual([
      { path: 'src/a.ts', source: 'claimed' },
      { path: 'src/a.ts', source: 'git' },
    ]);
  });

  it('is idempotent, because a settle can run more than once', () => {
    const id = card('a card');
    recordCardPaths(handle.sqlite, id, ['src/a.ts'], 'git', 1);
    recordCardPaths(handle.sqlite, id, ['src/a.ts'], 'git', 2);

    expect(pathsForCard(handle.sqlite, id)).toHaveLength(1);
  });

  it('ignores blank paths rather than storing them', () => {
    const id = card('a card');
    expect(recordCardPaths(handle.sqlite, id, ['', '  '], 'git', 1)).toBe(0);
  });

  it('counts a path once however many sources saw it', () => {
    const id = card('a card');
    recordCardPaths(handle.sqlite, id, ['src/server/a.ts'], 'git', 1);
    recordCardPaths(handle.sqlite, id, ['src/server/a.ts', 'src/server/b.ts'], 'claimed', 1);

    // The question is how much of the subsystem the card touched, not how many
    // times a file was mentioned.
    expect(subsystemsForCard(handle.sqlite, id)).toEqual([{ subsystem: 'src/server', paths: 3 }]);
  });
});

describe('finding the cards that worked here before', () => {
  it('ranks by how much they overlap', () => {
    const mine = card('mine');
    const close = card('touched the same three');
    const distant = card('touched one shared file');

    recordCardPaths(handle.sqlite, mine, ['a.ts', 'b.ts', 'c.ts'], 'git', 1);
    recordCardPaths(handle.sqlite, close, ['a.ts', 'b.ts', 'c.ts'], 'git', 1);
    recordCardPaths(handle.sqlite, distant, ['a.ts', 'z.ts'], 'git', 1);

    const related = cardsTouching(handle.sqlite, BOARD, mine);

    // A card that changed the same three files is worth more than one that
    // happened to touch a shared type definition.
    expect(related.map((entry) => entry.title)).toEqual([
      'touched the same three',
      'touched one shared file',
    ]);
  });

  it('never returns the card itself', () => {
    const mine = card('mine');
    recordCardPaths(handle.sqlite, mine, ['a.ts'], 'git', 1);

    expect(cardsTouching(handle.sqlite, BOARD, mine)).toEqual([]);
  });

  it('does not reach into another board', () => {
    handle.db
      .insert(boards)
      .values({ id: 'other', name: 'o', cwd: `${dir}/o`, createdAt: 1 })
      .run();
    createDefaultColumns(handle.db, 'other');

    const mine = card('mine');
    const elsewhere = createCard(handle, { boardId: 'other', title: 'elsewhere' }).id;
    recordCardPaths(handle.sqlite, mine, ['a.ts'], 'git', 1);
    recordCardPaths(handle.sqlite, elsewhere, ['a.ts'], 'git', 1);

    // Two projects with a file called `a.ts` are not related work.
    expect(cardsTouching(handle.sqlite, BOARD, mine)).toEqual([]);
  });
});

describe('what the run said and git did not see', () => {
  it('lists the difference', () => {
    const id = card('a card');
    recordCardPaths(handle.sqlite, id, ['kept.ts'], 'git', 1);
    recordCardPaths(handle.sqlite, id, ['kept.ts', 'reverted.ts'], 'claimed', 1);

    expect(claimedButNotInGit(handle.sqlite, id)).toEqual(['reverted.ts']);
  });

  it('is empty when the two agree', () => {
    const id = card('a card');
    recordCardPaths(handle.sqlite, id, ['a.ts'], 'git', 1);
    recordCardPaths(handle.sqlite, id, ['a.ts'], 'claimed', 1);

    expect(claimedButNotInGit(handle.sqlite, id)).toEqual([]);
  });

  it('says nothing about a card that never ran', () => {
    // Absent evidence, not evidence the card touched nothing.
    expect(claimedButNotInGit(handle.sqlite, card('never ran'))).toEqual([]);
    expect(subsystemsForCard(handle.sqlite, card('also never ran'))).toEqual([]);
  });
});
