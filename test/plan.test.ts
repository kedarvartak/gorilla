import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { addDependency, createCard, moveCard, updateCard } from '../src/server/api/cards.js';
import { createDefaultColumns } from '../src/server/cards/defaults.js';
import { buildPlan, describePlan } from '../src/server/cards/plan.js';
import { openDatabase, type DatabaseHandle } from '../src/server/db/client.js';
import { boards, columns } from '../src/server/db/schema.js';
import { eq } from 'drizzle-orm';

/**
 * The order the board will work in, and what each card waits for (T64).
 *
 * The backlog asked for a drawn graph. Edges answer "what depends on what";
 * the operator's question is "why has nothing started".
 */

let dir: string;
let handle: DatabaseHandle;
const BOARD = 'board-1';

function readyColumn(): string {
  const found = handle.db.select().from(columns).where(eq(columns.name, 'Ready')).get();
  if (found === undefined) throw new Error('no Ready column');
  return found.id;
}

function card(title: string): string {
  const created = createCard(handle, { boardId: BOARD, title });
  moveCard(handle, created.id, readyColumn(), 0);
  return created.id;
}

function plan() {
  return buildPlan(handle.db, BOARD);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gorilla-plan-'));
  handle = openDatabase({ path: join(dir, 'p.db') });
  handle.db.insert(boards).values({ id: BOARD, name: 'b', cwd: dir, createdAt: 1 }).run();
  createDefaultColumns(handle.db, BOARD);
});

afterEach(() => {
  handle.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('what the plan says', () => {
  it('names what a blocked card is waiting for', () => {
    const blocker = card('the schema migration');
    const blocked = card('the thing that needs it');
    addDependency(handle, blocked, blocker);

    const waiting = plan().cards.find((entry) => entry.cardId === blocked);

    // "Waiting for 4f2a1b9c" is a lookup. "Waiting for the schema migration"
    // is an answer.
    expect(waiting?.waitingFor).toEqual(['the schema migration']);
  });

  it('counts what can start now', () => {
    const blocker = card('first');
    const blocked = card('second');
    addDependency(handle, blocked, blocker);

    expect(plan().free).toBe(1);
  });

  it('never ranks a card before what it depends on', () => {
    const blocker = card('must be first');
    const blocked = card('must be second');
    addDependency(handle, blocked, blocker);

    const ranks = new Map(plan().cards.map((entry) => [entry.title, entry.rank]));
    expect(ranks.get('must be first')).toBeLessThan(ranks.get('must be second') ?? 0);
  });

  it('leaves finished cards out', () => {
    const done = card('already done');
    updateCard(handle, done, { status: 'done' });
    card('still to do');

    // A number beside a done card is an instruction to do something already
    // done.
    expect(plan().cards.map((entry) => entry.title)).toEqual(['still to do']);
  });
});

describe('how it reads', () => {
  it('separates what can start from what is waiting', () => {
    const blocker = card('a');
    const blocked = card('b');
    addDependency(handle, blocked, blocker);

    expect(describePlan(plan())).toBe(
      '1 of 2 card(s) can start now; 1 are waiting on another card.',
    );
  });

  it('says so when nothing is waiting on anything', () => {
    card('a');
    card('b');

    expect(describePlan(plan())).toContain('none waiting on another');
  });

  it('says so when there is nothing left', () => {
    expect(describePlan(plan())).toContain('Nothing is left to do');
  });

  it('has no message for a board where nothing can start', () => {
    // That state is unreachable: cycles are refused at creation and a finite
    // acyclic graph always has a source. A message for it would sit in the
    // code looking like a handled case.
    const first = card('a');
    const second = card('b');
    addDependency(handle, second, first);

    expect(plan().free).toBeGreaterThan(0);
  });
});
