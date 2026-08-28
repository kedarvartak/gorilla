import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createDefaultColumns } from '../src/server/cards/defaults.js';
import { dispatchableCards, dispatchStanding } from '../src/server/cards/eligibility.js';
import { openDatabase, type DatabaseHandle } from '../src/server/db/client.js';
import { boards, cardDependencies, cards, columns } from '../src/server/db/schema.js';

/**
 * Why a card cannot run.
 *
 * The reason and the rule have to be the same rule. A tile that says a card is
 * waiting on a dependency while the dispatcher would have run it is worse than
 * a tile that says nothing, because the operator acts on it.
 */

let dir: string;
let handle: DatabaseHandle;
const BOARD = 'board-1';

function columnNamed(name: string): string {
  const found = handle.db.select().from(columns).where(eq(columns.name, name)).get();
  if (found === undefined) throw new Error(`no column ${name}`);
  return found.id;
}

function card(
  title: string,
  over: {
    column?: string;
    status?: string;
    goalCondition?: string | null;
    archivedAt?: number | null;
  } = {},
): string {
  const id = randomUUID();
  handle.db
    .insert(cards)
    .values({
      id,
      boardId: BOARD,
      columnId: columnNamed(over.column ?? 'Ready'),
      title,
      position: handle.db.select().from(cards).all().length,
      priority: 'normal',
      status: (over.status ?? 'idle') as 'idle',
      goalCondition:
        over.goalCondition === undefined
          ? '`npm test` exits 0, or stop after 20 turns'
          : over.goalCondition,
      archivedAt: over.archivedAt ?? null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    .run();
  return id;
}

function reasonFor(id: string): string | null {
  const found = dispatchStanding(handle.db, BOARD).find((entry) => entry.id === id);
  if (found === undefined) throw new Error('card missing from the standing');
  return found.reason;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gorilla-standing-'));
  handle = openDatabase({ path: join(dir, 'standing.db') });
  handle.db.insert(boards).values({ id: BOARD, name: 't', cwd: '/p', createdAt: Date.now() }).run();
  createDefaultColumns(handle.db, BOARD);
});

afterEach(() => {
  handle.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('why a card cannot run', () => {
  it('says nothing about a card that can', () => {
    expect(reasonFor(card('ready to go'))).toBeNull();
  });

  it('names the column a card has to leave', () => {
    const reason = reasonFor(card('written down', { column: 'Intake' }));
    expect(reason).toContain('Intake');
  });

  it('says a card has no goal condition, because that would halt the queue', () => {
    expect(reasonFor(card('titled only', { goalCondition: '' }))).toContain('goal condition');
    expect(reasonFor(card('null goal', { goalCondition: null }))).toContain('goal condition');
  });

  it('names what a blocked card is waiting on, and its state', () => {
    const first = card('the prerequisite');
    const second = card('the dependent');
    handle.db.insert(cardDependencies).values({ cardId: second, dependsOnCardId: first }).run();

    const reason = reasonFor(second);
    expect(reason).toContain('the prerequisite');
    expect(reason).toContain('idle');
  });

  it('treats an archived card as put away rather than as faulty', () => {
    expect(reasonFor(card('put away', { archivedAt: Date.now() }))).toContain('archived');
  });

  it('offers no reason for a running card, which needs a stop rather than a start', () => {
    expect(reasonFor(card('in flight', { status: 'running' }))).toBeNull();
  });

  it('offers no control at all in a terminal column, where none was expected', () => {
    const done = card('finished', { column: 'Done' });
    const entry = dispatchStanding(handle.db, BOARD).find((row) => row.id === done);
    expect(entry?.offer).toBe(false);
  });

  it('offers a control everywhere a card could still be worked on', () => {
    for (const column of ['Intake', 'Ready', 'Needs Review']) {
      const id = card(`in ${column}`, { column });
      const entry = dispatchStanding(handle.db, BOARD).find((row) => row.id === id);
      expect(entry?.offer).toBe(true);
    }
  });

  /**
   * The one that matters. Two descriptions of one rule drift, and the drift is
   * invisible until an operator is told a card is blocked that the dispatcher
   * is about to run.
   */
  it('agrees with the rule the dispatcher actually uses', () => {
    card('runnable');
    card('wrong column', { column: 'Intake' });
    card('no goal', { goalCondition: '' });
    card('archived', { archivedAt: Date.now() });

    const dispatchable = new Set(dispatchableCards(handle.db, BOARD).map((entry) => entry.id));
    for (const entry of dispatchStanding(handle.db, BOARD)) {
      const row = handle.db.select().from(cards).where(eq(cards.id, entry.id)).get();
      if (row?.status === 'running') continue;
      expect(entry.reason === null).toBe(dispatchable.has(entry.id));
    }
  });
});
