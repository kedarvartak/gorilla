import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createCard, updateCard } from '../src/server/api/cards.js';
import { createDefaultColumns } from '../src/server/cards/defaults.js';
import { searchCards } from '../src/server/cards/search.js';
import { recordCardPaths } from '../src/server/cards/subsystems.js';
import { openDatabase, type DatabaseHandle } from '../src/server/db/client.js';
import { boards } from '../src/server/db/schema.js';

/**
 * Finding a card again (T34).
 *
 * The interesting half only became possible once the subsystem map existed:
 * the card that touched a file is usually the card being looked for, and its
 * title may not mention the file at all.
 */

let dir: string;
let handle: DatabaseHandle;
const BOARD = 'board-1';

function card(title: string, body = ''): string {
  const created = createCard(handle, { boardId: BOARD, title });
  if (body !== '') updateCard(handle, created.id, { body });
  return created.id;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gorilla-search-'));
  handle = openDatabase({ path: join(dir, 's.db') });
  handle.db.insert(boards).values({ id: BOARD, name: 'b', cwd: dir, createdAt: 1 }).run();
  createDefaultColumns(handle.db, BOARD);
});

afterEach(() => {
  handle.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('searching', () => {
  it('finds a card by its title, whatever the case', () => {
    card('The Dispatcher');

    expect(searchCards(handle.sqlite, BOARD, 'dispatcher')).toHaveLength(1);
  });

  it('finds a card by its body', () => {
    card('Something else', 'This touches the dispatcher.');

    expect(searchCards(handle.sqlite, BOARD, 'dispatcher')[0]?.matched).toEqual(['body']);
  });

  it('finds a card by a file it touched', () => {
    const id = card('An unhelpfully named card');
    recordCardPaths(handle.sqlite, id, ['src/server/dispatch/stall.ts'], 'git', 1);

    const hits = searchCards(handle.sqlite, BOARD, 'stall.ts');

    // The whole reason to search paths: nothing in the title would have found
    // this, and it is the card being looked for.
    expect(hits[0]?.cardId).toBe(id);
    expect(hits[0]?.path).toBe('src/server/dispatch/stall.ts');
  });

  it('puts a title match above a file match', () => {
    const edited = card('An unrelated card');
    recordCardPaths(handle.sqlite, edited, ['src/dispatcher.ts'], 'git', 1);
    const named = card('The dispatcher');

    // Six cards that merely edited the file, ranked above the card called
    // 'the dispatcher', is a worse answer than no search.
    expect(searchCards(handle.sqlite, BOARD, 'dispatcher')[0]?.cardId).toBe(named);
  });

  it('says why a card matched', () => {
    card('The dispatcher', 'Also mentions the dispatcher.');

    // A surprising hit that cannot explain itself reads as a broken search.
    expect(searchCards(handle.sqlite, BOARD, 'dispatcher')[0]?.matched).toEqual(['title', 'body']);
  });

  it('returns nothing for an empty query', () => {
    card('anything');

    // Matching everything is, as a search result, the same as matching nothing
    // and more confusing.
    expect(searchCards(handle.sqlite, BOARD, '   ')).toEqual([]);
  });

  it('treats a wildcard as a character, not as a wildcard', () => {
    card('one hundred %');
    card('nothing to do with it');

    expect(searchCards(handle.sqlite, BOARD, '%')).toHaveLength(1);
  });

  it('does not reach into another board', () => {
    handle.db
      .insert(boards)
      .values({ id: 'other', name: 'o', cwd: `${dir}/o`, createdAt: 1 })
      .run();
    createDefaultColumns(handle.db, 'other');
    createCard(handle, { boardId: 'other', title: 'the dispatcher' });

    expect(searchCards(handle.sqlite, BOARD, 'dispatcher')).toEqual([]);
  });
});
