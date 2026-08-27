import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { assembleBackground, isEmpty } from '../src/server/cards/background.js';
import { cardContextInput, previousRunsFor } from '../src/server/cards/card-context.js';
import { createDefaultColumns } from '../src/server/cards/defaults.js';
import { recordCardPaths } from '../src/server/cards/subsystems.js';
import { renderCardContext } from '../src/server/launcher/args.js';
import { openDatabase, type DatabaseHandle } from '../src/server/db/client.js';
import {
  boards,
  cardDependencies,
  cards,
  columns,
  invariants,
  runs,
} from '../src/server/db/schema.js';

/**
 * What the board tells the agent about the work.
 *
 * The board computed every one of these facts for the card detail and told
 * the agent none of them, which is T19's stated purpose - "so an agent
 * inherits the prior finding" - stopping at the screen.
 */

let dir: string;
let handle: DatabaseHandle;
const BOARD = 'board-1';

function columnNamed(name: string): string {
  const found = handle.db.select().from(columns).where(eq(columns.name, name)).get();
  if (found === undefined) throw new Error(`no column ${name}`);
  return found.id;
}

function card(title: string, over: { guardrails?: string; body?: string } = {}): string {
  const id = randomUUID();
  handle.db
    .insert(cards)
    .values({
      id,
      boardId: BOARD,
      columnId: columnNamed('Ready'),
      title,
      body: over.body ?? '',
      guardrails: over.guardrails ?? '{}',
      position: handle.db.select().from(cards).all().length,
      priority: 'normal',
      status: 'idle',
      goalCondition: '`npm test` exits 0, or stop after 20 turns',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    .run();
  return id;
}

function backgroundFor(id: string) {
  const row = handle.db.select().from(cards).where(eq(cards.id, id)).get();
  if (row === undefined) throw new Error('no card');
  return assembleBackground({
    db: handle.db,
    sqlite: handle.sqlite,
    boardId: BOARD,
    cardId: id,
    title: row.title,
    body: row.body,
    guardrails: row.guardrails,
    previousRuns: previousRunsFor(handle, id),
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gorilla-background-'));
  handle = openDatabase({ path: join(dir, 'b.db') });
  handle.db.insert(boards).values({ id: BOARD, name: 't', cwd: '/p', createdAt: Date.now() }).run();
  createDefaultColumns(handle.db, BOARD);
});

afterEach(() => {
  handle.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('what the board knows about a card', () => {
  it('knows nothing about a card with no history and no neighbours', () => {
    expect(isEmpty(backgroundFor(card('brand new')))).toBe(true);
  });

  it('names the earlier cards that changed the same files', () => {
    const earlier = card('the card that touched the ingest');
    const now = card('another go at the ingest');
    recordCardPaths(handle.sqlite, earlier, ['src/server/ingest/hooks.ts'], 'git', Date.now());
    recordCardPaths(handle.sqlite, now, ['src/server/ingest/hooks.ts'], 'git', Date.now());

    const background = backgroundFor(now);
    expect(background.related.map((entry) => entry.title)).toEqual([
      'the card that touched the ingest',
    ]);
    expect(background.related[0]?.shared).toContain('src/server/ingest/hooks.ts');
  });

  it('names what this card has already touched', () => {
    const id = card('has run before');
    recordCardPaths(handle.sqlite, id, ['src/server/ingest/hooks.ts'], 'git', Date.now());

    expect(backgroundFor(id).touched.join(' ')).toContain('src/server');
  });

  /**
   * A guess and a fact must not arrive together. Once a card has touched real
   * files, what it touched outranks a guess from similar wording, and handing
   * an agent both makes it weigh one against the other for nothing.
   */
  it('withholds the guess once the card has a history of its own', () => {
    const earlier = card('ingest work');
    recordCardPaths(handle.sqlite, earlier, ['src/server/ingest/a.ts'], 'git', Date.now());
    handle.db.update(cards).set({ mergedAt: Date.now() }).where(eq(cards.id, earlier)).run();

    const later = card('ingest work again');
    recordCardPaths(handle.sqlite, later, ['src/server/ingest/a.ts'], 'git', Date.now());

    expect(backgroundFor(later).blastRadius).toBeNull();
  });

  it('says what this card is waiting on, and what state it is in', () => {
    const first = card('the prerequisite');
    const second = card('the dependent');
    handle.db.insert(cardDependencies).values({ cardId: second, dependsOnCardId: first }).run();

    expect(backgroundFor(second).waitingOn.join(' ')).toContain('the prerequisite');
  });

  it('carries a project rule the card is scoped against', () => {
    handle.db
      .insert(invariants)
      .values({
        id: randomUUID(),
        boardId: BOARD,
        statement: 'Never change src/server/db/schema.ts without a migration.',
        createdAt: Date.now(),
      })
      .run();

    const id = card('touch the schema', {
      guardrails: JSON.stringify({ scope: ['src/server/db/schema.ts'] }),
    });

    expect(backgroundFor(id).contradictions.join(' ')).toContain('schema.ts');
  });
});

describe('what previous runs are said to have done', () => {
  function runFor(cardId: string, over: Record<string, unknown>): void {
    handle.db
      .insert(runs)
      .values({
        id: randomUUID(),
        boardId: BOARD,
        cardId,
        sessionId: randomUUID(),
        cwd: '/p',
        startedAt: Date.now(),
        mode: 'launched',
        ...over,
      } as never)
      .run();
  }

  /**
   * The real database has `end_reason = 'other'` on nine of eleven runs and
   * `goal_outcome` null on all of them. Printing the columns produces "Run 1:
   * other", which costs a second attempt a line of attention to learn nothing.
   */
  it('says an absence is an absence rather than printing the column', () => {
    const id = card('has run');
    runFor(id, { endReason: 'other', endedAt: Date.now() });

    expect(previousRunsFor(handle, id)[0]).toContain('without recording an outcome');
  });

  it('says a run that never ended was cut off', () => {
    const id = card('cut off');
    runFor(id, { endedAt: null });

    expect(previousRunsFor(handle, id)[0]).toContain('cut off');
  });

  it('reports a real goal outcome when there is one', () => {
    const id = card('finished');
    runFor(id, { goalOutcome: 'met', endedAt: Date.now() });

    expect(previousRunsFor(handle, id)[0]).toContain('met');
  });
});

describe('the context file the session is handed', () => {
  it('places the background below the constraints and above the ledger', () => {
    const earlier = card('earlier work');
    const id = card('this card');
    recordCardPaths(handle.sqlite, earlier, ['src/a.ts'], 'git', Date.now());
    recordCardPaths(handle.sqlite, id, ['src/a.ts'], 'git', Date.now());

    const row = handle.db.select().from(cards).where(eq(cards.id, id)).get();
    const rendered = renderCardContext({
      ...cardContextInput(handle, row as never),
      acceptedEntries: ['something established earlier'],
    });

    const background = rendered.indexOf('What the board already knows');
    const established = rendered.indexOf('Established on this card');
    expect(background).toBeGreaterThan(-1);
    expect(background).toBeLessThan(established);
  });

  it('says nothing at all when the board knows nothing', () => {
    const id = card('brand new');
    const row = handle.db.select().from(cards).where(eq(cards.id, id)).get();

    // An empty heading is worse than no heading: it teaches the agent that
    // the section is usually empty, and it will skim it on the card where it
    // is not.
    expect(renderCardContext(cardContextInput(handle, row as never))).not.toContain(
      'What the board already knows',
    );
  });

  it('tells the agent the background is context rather than instruction', () => {
    const earlier = card('earlier work');
    const id = card('this card');
    recordCardPaths(handle.sqlite, earlier, ['src/a.ts'], 'git', Date.now());
    recordCardPaths(handle.sqlite, id, ['src/a.ts'], 'git', Date.now());

    const row = handle.db.select().from(cards).where(eq(cards.id, id)).get();
    expect(renderCardContext(cardContextInput(handle, row as never))).toContain(
      'context, not instruction',
    );
  });
});
