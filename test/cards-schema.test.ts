import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createDefaultColumns,
  deleteBoard,
  DEFAULT_COLUMNS,
} from '../src/server/cards/defaults.js';
import {
  blockersFor,
  canMoveTo,
  dispatchableCards,
  wouldCycle,
} from '../src/server/cards/eligibility.js';
import {
  describeGuardrails,
  guardrailSummary,
  parseGuardrails,
  prohibitionIsExpressible,
  serialiseGuardrails,
  EMPTY_GUARDRAILS,
  type GuardrailSet,
} from '../src/server/cards/guardrails.js';
import { createCard, isPriority, updateCard } from '../src/server/api/cards.js';
import { openDatabase, type DatabaseHandle } from '../src/server/db/client.js';
import { boards, cardDependencies, cards, columns, events, runs } from '../src/server/db/schema.js';

let dir: string;
let handle: DatabaseHandle;

const BOARD = 'board-1';

function board(): void {
  handle.db
    .insert(boards)
    .values({ id: BOARD, name: 'test', cwd: '/p', createdAt: Date.now() })
    .run();
  createDefaultColumns(handle.db, BOARD);
}

function columnNamed(name: string): string {
  const found = handle.db.select().from(columns).where(eq(columns.name, name)).get();
  if (found === undefined) throw new Error(`no column ${name}`);
  return found.id;
}

function card(title: string, columnName = 'Ready', status = 'idle'): string {
  const id = randomUUID();
  handle.db
    .insert(cards)
    .values({
      id,
      boardId: BOARD,
      columnId: columnNamed(columnName),
      title,
      position: 0,
      status: status as 'idle',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    .run();
  return id;
}

function dependsOn(cardId: string, dependencyId: string): void {
  handle.db.insert(cardDependencies).values({ cardId, dependsOnCardId: dependencyId }).run();
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gorilla-cards-'));
  handle = openDatabase({ path: join(dir, 'cards.db') });
});

afterEach(() => {
  handle.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('migration', () => {
  it('creates every Phase 1 table', () => {
    const names = handle.sqlite
      .prepare<[], { name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => row.name);

    expect(names).toEqual(
      expect.arrayContaining([
        'boards',
        'runs',
        'events',
        'columns',
        'cards',
        'plans',
        'card_dependencies',
      ]),
    );
  });

  it('preserves Phase 0 data when applied to an existing database', () => {
    // The migration must be additive: the event history is the audit trail
    // everything else traces back to, and losing it is unrecoverable.
    const path = join(dir, 'existing.db');

    const before = openDatabase({ path });
    before.db.insert(boards).values({ id: 'b', name: 'n', cwd: '/x', createdAt: 1 }).run();
    before.db
      .insert(runs)
      .values({ id: 'r', boardId: 'b', sessionId: 's', cwd: '/x', startedAt: 1 })
      .run();
    before.db
      .insert(events)
      .values({
        runId: 'r',
        sessionId: 's',
        seq: 1,
        eventName: 'Stop',
        receivedAt: 1,
        payload: '{}',
      })
      .run();
    before.close();

    const after = openDatabase({ path });
    expect(after.db.select().from(events).all()).toHaveLength(1);
    expect(after.db.select().from(boards).all()).toHaveLength(1);
    after.close();
  });

  it('refuses to delete a column that still holds cards', () => {
    board();
    card('keeps the column busy');

    expect(() =>
      handle.db
        .delete(columns)
        .where(eq(columns.id, columnNamed('Ready')))
        .run(),
    ).toThrow(/FOREIGN KEY/i);
  });

  it('removes cards and columns when a board is deleted', () => {
    board();
    card('doomed');

    deleteBoard(handle, BOARD);

    expect(handle.db.select().from(cards).all()).toHaveLength(0);
    expect(handle.db.select().from(columns).all()).toHaveLength(0);
    expect(handle.db.select().from(boards).all()).toHaveLength(0);
  });
});

describe('default columns', () => {
  it('creates the doc 05 set with exactly one gate and one terminal', () => {
    board();
    const all = handle.db.select().from(columns).all();

    expect(all).toHaveLength(DEFAULT_COLUMNS.length);
    expect(all.filter((column) => column.isTerminal)).toHaveLength(1);
    expect(all.filter((column) => column.isReviewGate)).toHaveLength(1);
    expect(all.filter((column) => column.isReady)).toHaveLength(1);
  });

  it('does not duplicate on a second call', () => {
    board();
    createDefaultColumns(handle.db, BOARD);
    expect(handle.db.select().from(columns).all()).toHaveLength(DEFAULT_COLUMNS.length);
  });

  it('gives a second board its own columns', () => {
    board();

    handle.db
      .insert(boards)
      .values({ id: 'board-2', name: 'other', cwd: '/other', createdAt: Date.now() })
      .run();
    createDefaultColumns(handle.db, 'board-2');

    // The guard is per board. Checking whether any columns exist at all left
    // the second board with none, and every card creation on it then failed.
    const second = handle.db.select().from(columns).where(eq(columns.boardId, 'board-2')).all();
    expect(second).toHaveLength(DEFAULT_COLUMNS.length);
  });
});

describe('dependencies', () => {
  it('blocks the terminal column while a dependency is unfinished', () => {
    board();
    const first = card('first');
    const second = card('second');
    dependsOn(second, first);

    const decision = canMoveTo(handle.db, second, columnNamed('Done'));

    expect(decision.allowed).toBe(false);
    expect(decision.blockers).toHaveLength(1);
    expect(decision.reason).toContain('first');
  });

  it('allows the terminal column once the dependency is done', () => {
    board();
    const first = card('first');
    const second = card('second');
    dependsOn(second, first);

    handle.db.update(cards).set({ status: 'done' }).where(eq(cards.id, first)).run();

    expect(canMoveTo(handle.db, second, columnNamed('Done')).allowed).toBe(true);
  });

  it('does not block a non-terminal column', () => {
    board();
    const first = card('first');
    const second = card('second');
    dependsOn(second, first);

    expect(canMoveTo(handle.db, second, columnNamed('Running')).allowed).toBe(true);
  });

  it('reports every blocker, not just the first', () => {
    board();
    const target = card('target');
    dependsOn(target, card('a'));
    dependsOn(target, card('b'));

    expect(blockersFor(handle.db, target)).toHaveLength(2);
  });

  it('refuses a move to a column that does not exist', () => {
    board();
    expect(canMoveTo(handle.db, card('x'), 'nope').allowed).toBe(false);
  });
});

describe('dispatch eligibility', () => {
  it('lists only unblocked idle cards in a ready column', () => {
    board();
    const blocked = card('blocked');
    dependsOn(blocked, card('blocker'));
    card('free');
    card('not ready', 'Intake');
    card('already running', 'Ready', 'running');

    const eligible = dispatchableCards(handle.db, BOARD).map((c) => c.title);

    expect(eligible).toContain('free');
    expect(eligible).toContain('blocker');
    expect(eligible).not.toContain('blocked');
    expect(eligible).not.toContain('not ready');
    expect(eligible).not.toContain('already running');
  });
});

describe('cycle detection', () => {
  it('refuses a self-dependency', () => {
    board();
    const only = card('only');
    expect(wouldCycle(handle.db, only, only)).toBe(true);
  });

  it('detects an indirect cycle', () => {
    board();
    const a = card('a');
    const b = card('b');
    const c = card('c');
    dependsOn(b, a);
    dependsOn(c, b);

    // a -> c would close the loop a -> c -> b -> a.
    expect(wouldCycle(handle.db, a, c)).toBe(true);
    expect(wouldCycle(handle.db, a, card('unrelated'))).toBe(false);
  });
});

describe('guardrails', () => {
  const set: GuardrailSet = {
    scope: ['src/ingest/'],
    prohibit: ['src/db/schema.ts', 'over-engineer the solution', 'Bash(git push *)'],
    allowTools: ['Read', 'Edit'],
    verify: 'npm test',
    maxTurns: 20,
  };

  it('distinguishes hard rules from advisory ones', () => {
    const described = describeGuardrails(set);

    const pathRule = described.find((d) => d.text.includes('src/db/schema.ts'));
    const vagueRule = described.find((d) => d.text.includes('over-engineer'));
    const commandRule = described.find((d) => d.text.includes('git push'));

    expect(pathRule?.enforcement).toBe('hard');
    expect(commandRule?.enforcement).toBe('hard');
    // The R10 case: it reads like a rule but nothing can enforce it.
    expect(vagueRule?.enforcement).toBe('advisory');
  });

  it('treats scope as advisory, because nothing enforces it', () => {
    expect(describeGuardrails(set).find((d) => d.kind === 'scope')?.enforcement).toBe('advisory');
  });

  it('treats the verify command as hard, since the board runs it', () => {
    const verify = describeGuardrails(set).find((d) => d.kind === 'verify');
    expect(verify?.enforcement).toBe('hard');
    expect(verify?.because).toContain('board itself');
  });

  it('gives a reason for every enforcement decision', () => {
    for (const described of describeGuardrails(set)) {
      expect(described.because.length).toBeGreaterThan(10);
    }
  });

  it('counts hard and advisory rules', () => {
    // Hard: the path prohibition, the command prohibition, allowTools, verify.
    // Advisory: scope, the unenforceable prohibition, maxTurns.
    expect(guardrailSummary(set)).toEqual({ hard: 4, advisory: 3 });
  });

  it.each([
    ['src/db/schema.ts', true],
    ['src/**/*.ts', true],
    ['Bash(rm *)', true],
    ['change the schema', false],
    ['be careful', false],
    ['', false],
  ])('classifies %j as expressible=%s', (rule, expected) => {
    expect(prohibitionIsExpressible(rule)).toBe(expected);
  });

  it('round-trips through storage', () => {
    expect(parseGuardrails(serialiseGuardrails(set))).toEqual(set);
  });

  it('degrades a malformed value to empty rather than failing the card', () => {
    expect(parseGuardrails('not json')).toEqual(EMPTY_GUARDRAILS);
    expect(parseGuardrails('[]')).toEqual(EMPTY_GUARDRAILS);
    expect(parseGuardrails(null)).toEqual(EMPTY_GUARDRAILS);
    expect(parseGuardrails('{"scope": "wrong type"}').scope).toEqual([]);
    expect(parseGuardrails('{"maxTurns": -5}').maxTurns).toBeNull();
  });
});

describe('priority', () => {
  it('defaults to normal', () => {
    board();
    const created = createCard(handle, { boardId: BOARD, title: 'No priority given' });
    expect(created.priority).toBe('normal');
  });

  it('is stored as given, and editable afterwards', () => {
    board();
    const created = createCard(handle, { boardId: BOARD, title: 'Later', priority: 'low' });
    expect(created.priority).toBe('low');
    expect(updateCard(handle, created.id, { priority: 'high' }).priority).toBe('high');
  });

  it('rejects a value the ordering would not recognise', () => {
    // An unrecognised priority would sort as low, so an urgent card would run
    // last with nothing to explain why.
    expect(isPriority('high')).toBe(true);
    expect(isPriority('urgent')).toBe(false);
    expect(isPriority(1)).toBe(false);
  });

  it('actually reorders the dispatch queue', () => {
    board();
    const ready = columnNamed('Ready');
    createCard(handle, { boardId: BOARD, columnId: ready, title: 'first added', index: 0 });
    createCard(handle, { boardId: BOARD, columnId: ready, title: 'second added', index: 1 });
    createCard(handle, {
      boardId: BOARD,
      columnId: ready,
      title: 'urgent, added last',
      index: 2,
      priority: 'high',
    });

    const order = dispatchableCards(handle.db, BOARD).map((entry) => entry.title);

    // The chip is not decoration: a card marked high runs before its
    // neighbours despite being added last (R10).
    expect(order[0]).toBe('urgent, added last');
    expect(order.slice(1)).toEqual(['first added', 'second added']);
  });

  it('sends low-priority cards to the back', () => {
    board();
    const ready = columnNamed('Ready');
    createCard(handle, {
      boardId: BOARD,
      columnId: ready,
      title: 'deprioritised',
      index: 0,
      priority: 'low',
    });
    createCard(handle, { boardId: BOARD, columnId: ready, title: 'ordinary', index: 1 });

    expect(dispatchableCards(handle.db, BOARD).map((entry) => entry.title)).toEqual([
      'ordinary',
      'deprioritised',
    ]);
  });
});
