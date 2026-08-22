import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createCard } from '../src/server/api/cards.js';
import {
  describeBlastRadius,
  NOTHING,
  proposeBlastRadius,
} from '../src/server/cards/blast-radius.js';
import { createDefaultColumns } from '../src/server/cards/defaults.js';
import { recordCardPaths } from '../src/server/cards/subsystems.js';
import { openDatabase, type DatabaseHandle } from '../src/server/db/client.js';
import { boards } from '../src/server/db/schema.js';

/**
 * Guessing what a card will touch from what similar cards did touch (T18).
 *
 * A scope guardrail is written before anyone knows the answer. The board has
 * the answer for every card it has already run.
 */

let dir: string;
let handle: DatabaseHandle;
const BOARD = 'board-1';

function ran(title: string, paths: readonly string[]): string {
  const created = createCard(handle, { boardId: BOARD, title });
  recordCardPaths(handle.sqlite, created.id, paths, 'git', 1);
  return created.id;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gorilla-radius-'));
  handle = openDatabase({ path: join(dir, 'r.db') });
  handle.db.insert(boards).values({ id: BOARD, name: 'b', cwd: dir, createdAt: 1 }).run();
  createDefaultColumns(handle.db, BOARD);
});

afterEach(() => {
  handle.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('proposing a radius', () => {
  it('reads it off cards with similar titles', () => {
    ran('Stop the dispatcher halting on failure', ['src/server/dispatch/dispatcher.ts']);

    const radius = proposeBlastRadius(handle.sqlite, BOARD, 'Stop the dispatcher stalling');

    expect(radius.paths.map((entry) => entry.path)).toEqual(['src/server/dispatch/dispatcher.ts']);
  });

  it('counts how many similar cards touched each path', () => {
    ran('Dispatcher halting on failure', ['src/server/dispatch/dispatcher.ts', 'a.ts']);
    ran('Dispatcher halting on success', ['src/server/dispatch/dispatcher.ts']);

    // Evidence, not confidence: two cards is a better reason than one.
    expect(proposeBlastRadius(handle.sqlite, BOARD, 'Dispatcher halting').paths[0]).toEqual({
      path: 'src/server/dispatch/dispatcher.ts',
      cards: 2,
    });
  });

  it('says nothing when nothing resembles it', () => {
    ran('Export a brief as markdown', ['src/server/brief/markdown.ts']);

    expect(proposeBlastRadius(handle.sqlite, BOARD, 'Stop the queue overnight')).toEqual(NOTHING);
  });

  it('reads from at most three cards', () => {
    for (const suffix of ['one', 'two', 'three', 'four', 'five']) {
      ran(`Dispatcher halting ${suffix}`, [`src/${suffix}.ts`]);
    }

    // A radius assembled from every card sharing a word is the whole
    // repository, which is the same as no answer.
    expect(proposeBlastRadius(handle.sqlite, BOARD, 'Dispatcher halting').from).toHaveLength(3);
  });

  it('never reads from the card itself', () => {
    const id = ran('Dispatcher halting on failure', ['src/server/dispatch/dispatcher.ts']);

    expect(proposeBlastRadius(handle.sqlite, BOARD, 'Dispatcher halting on failure', id)).toEqual(
      NOTHING,
    );
  });

  it('ignores cards that have never run', () => {
    createCard(handle, { boardId: BOARD, title: 'Dispatcher halting, never run' });

    // A card with no recorded paths contributes nothing but its title, and a
    // radius of zero files dressed up as a proposal is noise.
    expect(proposeBlastRadius(handle.sqlite, BOARD, 'Dispatcher halting')).toEqual(NOTHING);
  });
});

describe('how it is said', () => {
  it('names the cards it was read from', () => {
    ran('Dispatcher halting on failure', ['src/server/dispatch/dispatcher.ts']);

    const note = describeBlastRadius(
      proposeBlastRadius(handle.sqlite, BOARD, 'Dispatcher halting on success'),
    );

    // 'These files' invites acceptance. 'These files, because these cards
    // touched them' invites checking, which is right for a guess.
    expect(note).toContain('Dispatcher halting on failure');
    expect(note).toContain('check it');
  });

  it('says nothing when there is nothing to say', () => {
    expect(describeBlastRadius(NOTHING)).toBeNull();
  });
});
