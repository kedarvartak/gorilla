import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createCard, getCard, updateCard } from '../src/server/api/cards.js';
import { describeContradictions, findContradictions } from '../src/server/cards/contradictions.js';
import { createDefaultColumns } from '../src/server/cards/defaults.js';
import { openDatabase, type DatabaseHandle } from '../src/server/db/client.js';
import { boards, invariants } from '../src/server/db/schema.js';

/**
 * A card that asks for something a project rule forbids (T16).
 *
 * Narrower than the backlog claimed. Deciding whether prose contradicts prose
 * is the model's job; doing it badly here would produce a warning wrong often
 * enough to be ignored. A card naming a path a rule prohibits is checkable.
 */

let dir: string;
let handle: DatabaseHandle;
const BOARD = 'board-1';

function rule(statement: string): void {
  handle.db
    .insert(invariants)
    .values({ id: randomUUID(), boardId: BOARD, statement, createdAt: 1 })
    .run();
}

function card(title: string, options: { body?: string; scope?: readonly string[] } = {}): string {
  const created = createCard(handle, { boardId: BOARD, title });
  updateCard(handle, created.id, {
    ...(options.body === undefined ? {} : { body: options.body }),
    ...(options.scope === undefined ? {} : { guardrails: { scope: options.scope } }),
  });
  return created.id;
}

function check(cardId: string) {
  return findContradictions(handle.sqlite, BOARD, getCard(handle, cardId));
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gorilla-contradictions-'));
  handle = openDatabase({ path: join(dir, 'c.db') });
  handle.db.insert(boards).values({ id: BOARD, name: 'b', cwd: dir, createdAt: 1 }).run();
  createDefaultColumns(handle.db, BOARD);
});

afterEach(() => {
  handle.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('a card against a project rule', () => {
  it('flags a card scoped to a path a rule prohibits', () => {
    rule('Never edit src/server/db/schema.ts by hand.');
    const id = card('Change the schema', { scope: ['src/server/db/schema.ts'] });

    expect(check(id)[0]?.where).toBe('scope');
  });

  it('flags a mention in the body more weakly than a scope', () => {
    rule('Never edit src/server/db/schema.ts by hand.');
    const id = card('Something else', { body: 'Read src/server/db/schema.ts for context.' });

    // A card can name a file it intends to leave alone, so which signal it was
    // travels with the finding.
    expect(check(id)[0]?.where).toBe('body');
  });

  it('ignores a rule that is not a prohibition', () => {
    rule('Migrations in src/server/db/migrations are additive.');
    const id = card('Add a migration', { scope: ['src/server/db/migrations'] });

    // A rule describing how something is done is not a rule against doing it.
    expect(check(id)).toEqual([]);
  });

  it('does not match on ordinary words', () => {
    rule('Never guess at a number the board could measure.');
    const id = card('Guess the size', { body: 'We should guess less.' });

    // Matching prose would flag every card containing the word guess, which is
    // a warning nobody reads by the second week.
    expect(check(id)).toEqual([]);
  });

  it('says nothing when the board has no rules', () => {
    expect(check(card('anything', { scope: ['src/server/db/schema.ts'] }))).toEqual([]);
  });

  it('says nothing when the card stays clear of them', () => {
    rule('Never edit src/server/db/schema.ts by hand.');

    expect(check(card('Unrelated', { scope: ['src/web'] }))).toEqual([]);
  });
});

describe('how it is said', () => {
  it('is worth a look rather than an error', () => {
    rule('Never edit src/server/db/schema.ts by hand.');
    const id = card('Change the schema', { scope: ['src/server/db/schema.ts'] });

    // A rule can prohibit a path precisely because this card is the one
    // allowed to change it. A board calling that a mistake would be wrong on
    // the most interesting card it ever sees.
    expect(describeContradictions(check(id))).toContain('Worth a look');
  });

  it('says nothing when there is nothing to say', () => {
    expect(describeContradictions([])).toBeNull();
  });
});
