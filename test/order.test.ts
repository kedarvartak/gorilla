import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createDefaultColumns } from '../src/server/cards/defaults.js';
import { dispatchableCards } from '../src/server/cards/eligibility.js';
import { executionOrder } from '../src/server/cards/order.js';
import { openDatabase, type DatabaseHandle } from '../src/server/db/client.js';
import { boards, cardDependencies, cards, columns } from '../src/server/db/schema.js';

/**
 * The order the remaining cards should be worked in.
 *
 * The number has to agree with what the dispatcher does next, or it is a
 * confident instruction that the queue then ignores.
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
    priority?: 'high' | 'normal' | 'low';
    status?: string;
    position?: number;
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
      position: over.position ?? handle.db.select().from(cards).all().length,
      priority: over.priority ?? 'normal',
      status: (over.status ?? 'idle') as 'idle',
      goalCondition: '`npm test` exits 0, or stop after 20 turns',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    .run();
  return id;
}

function dependsOn(cardId: string, dependencyId: string): void {
  handle.db.insert(cardDependencies).values({ cardId, dependsOnCardId: dependencyId }).run();
}

function titles(): string[] {
  const byId = new Map(
    handle.db
      .select()
      .from(cards)
      .all()
      .map((c) => [c.id, c.title]),
  );
  return executionOrder(handle.db, BOARD).map((entry) => byId.get(entry.cardId) ?? '?');
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gorilla-order-'));
  handle = openDatabase({ path: join(dir, 'order.db') });
  handle.db.insert(boards).values({ id: BOARD, name: 't', cwd: '/p', createdAt: Date.now() }).run();
  createDefaultColumns(handle.db, BOARD);
});

afterEach(() => {
  handle.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('ranking the remaining work', () => {
  it('numbers from one, contiguously', () => {
    card('a');
    card('b');

    expect(executionOrder(handle.db, BOARD).map((e) => e.rank)).toEqual([1, 2]);
  });

  it('puts high priority first', () => {
    card('ordinary');
    card('urgent', { priority: 'high' });

    expect(titles()).toEqual(['urgent', 'ordinary']);
  });

  it('never ranks a card before something it depends on', () => {
    const first = card('foundation');
    const second = card('built on it', { priority: 'high' });
    dependsOn(second, first);

    // Priority loses to a dependency: the high card cannot run first however
    // urgent it is, and saying otherwise would be an instruction that fails.
    expect(titles()).toEqual(['foundation', 'built on it']);
  });

  it('follows a chain of dependencies', () => {
    const p3 = card('P3');
    const p4 = card('P4');
    const p5 = card('P5');
    dependsOn(p5, p4);
    dependsOn(p4, p3);

    expect(titles()).toEqual(['P3', 'P4', 'P5']);
  });

  it('marks which ranked cards cannot be started yet', () => {
    const first = card('foundation');
    const second = card('built on it');
    dependsOn(second, first);

    const order = executionOrder(handle.db, BOARD);
    expect(order[0]?.blocked).toBe(false);
    expect(order[1]?.blocked).toBe(true);
  });

  it('ignores a dependency that is already finished', () => {
    const done = card('already done', { status: 'done' });
    const next = card('free now');
    dependsOn(next, done);

    // Holding a card back for a satisfied dependency would strand it for ever.
    const order = executionOrder(handle.db, BOARD);
    expect(order).toHaveLength(1);
    expect(order[0]?.blocked).toBe(false);
  });

  it('excludes finished cards rather than ranking them last', () => {
    card('done one', { status: 'done' });
    card('abandoned one', { status: 'abandoned' });
    card('real work');

    // A number beside a done card is an instruction to do something done.
    expect(titles()).toEqual(['real work']);
  });

  it('agrees with the order the dispatcher will actually use', () => {
    card('third', { position: 3 });
    card('first', { priority: 'high', position: 9 });
    card('second', { position: 1 });

    const ranked = titles().filter((title) =>
      dispatchableCards(handle.db, BOARD).some((entry) => entry.title === title),
    );

    // Printing a number the queue then ignores would be worse than printing
    // none, so both sort by column, then priority, then position.
    expect(ranked).toEqual(dispatchableCards(handle.db, BOARD).map((entry) => entry.title));
  });

  it('still ranks every card when a cycle somehow exists', () => {
    const a = card('a');
    const b = card('b');
    dependsOn(a, b);
    dependsOn(b, a);

    // `wouldCycle` refuses these at write time, but dropping cards from the
    // interface would be a worse failure than ordering them arbitrarily.
    expect(executionOrder(handle.db, BOARD)).toHaveLength(2);
  });
});
