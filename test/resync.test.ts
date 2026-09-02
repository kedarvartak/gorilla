import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resync } from '../src/server/cards/resync.js';
import type {
  ResyncJudge,
  ResyncJudgement,
  ResyncSubject,
} from '../src/server/cards/resync-agent.js';
import { createDefaultColumns } from '../src/server/cards/defaults.js';
import { openDatabase, type DatabaseHandle } from '../src/server/db/client.js';
import { boards, cards, columns } from '../src/server/db/schema.js';

/**
 * Catching up with work done in another harness (issue 173).
 *
 * The agent is substituted throughout. What is being tested is the board's
 * half - who gets asked, what a verdict is allowed to do, and what happens
 * when the answer is wrong or absent - and none of that should depend on a
 * model being reachable or on what it says today.
 *
 * The assertions that matter are the refusals. Moving a finished card is easy;
 * the failure that costs something is moving a card that is not finished, or
 * acting on a verdict about a card nobody asked about.
 */

let dir: string;
let repo: string;
let database: DatabaseHandle;
let boardId: string;

/** Every card put to the judge, in the order the sweeps happened. */
let asked: ResyncSubject[][];

/** A judge that answers from a script and records what it was given. */
function judgeReturning(
  verdicts: ResyncJudgement['verdicts'],
  usage: ResyncJudgement['usage'] = null,
): ResyncJudge {
  return (request) => {
    asked.push([...request.cards]);
    return Promise.resolve({ verdicts, usage, model: 'test-model' });
  };
}

function columnNamed(name: string): string {
  const column = database.db
    .select()
    .from(columns)
    .where(eq(columns.boardId, boardId))
    .all()
    .find((entry) => entry.name === name);
  if (column === undefined) throw new Error(`No "${name}" column.`);
  return column.id;
}

function addCard(over: {
  title: string;
  body?: string;
  status?: string;
  column?: string;
  archived?: boolean;
}): string {
  const id = `card-${over.title.replace(/\W/g, '')}`;
  const at = 1_700_000_000_000;

  database.db
    .insert(cards)
    .values({
      id,
      boardId,
      columnId: columnNamed(over.column ?? 'Intake'),
      title: over.title,
      body: over.body ?? '',
      position: at,
      status: (over.status ?? 'idle') as 'idle',
      createdAt: at,
      updatedAt: at,
      ...(over.archived === true ? { archivedAt: at } : {}),
    })
    .run();
  return id;
}

function cardRow(cardId: string): typeof cards.$inferSelect {
  const row = database.db.select().from(cards).where(eq(cards.id, cardId)).get();
  if (row === undefined) throw new Error('No such card.');
  return row;
}

function columnOf(cardId: string): string {
  const column = database.db
    .select()
    .from(columns)
    .where(eq(columns.id, cardRow(cardId).columnId))
    .get();
  return column?.name ?? '';
}

/** A file on disk, which is what makes a card look stale to the pre-filter. */
function writeRepoFile(path: string): void {
  mkdirSync(join(repo, path, '..'), { recursive: true });
  writeFileSync(join(repo, path), 'export const a = 1;\n');
}

beforeEach(() => {
  asked = [];
  dir = mkdtempSync(join(tmpdir(), 'gorilla-resync-'));
  repo = join(dir, 'repo');
  mkdirSync(repo);

  database = openDatabase({ path: join(dir, 'resync.db') });
  boardId = 'board-1';
  database.db
    .insert(boards)
    .values({ id: boardId, name: 'b', cwd: repo, createdAt: Date.now() })
    .run();
  createDefaultColumns(database.db, boardId);
});

afterEach(() => {
  database.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('who gets asked about', () => {
  it('asks about an abandoned card even though it names no file', async () => {
    const id = addCard({ title: 'Abandoned', status: 'abandoned' });

    await resync(database, boardId, repo, judgeReturning([]));

    // The whole reason this feature was rewritten. The git version could say
    // nothing at all about a card with no paths in it.
    expect(asked[0]?.map((card) => card.cardId)).toEqual([id]);
  });

  it('asks about a card whose files are all on disk and has never run', async () => {
    writeRepoFile('src/a.ts');
    const id = addCard({ title: 'Stale', body: 'Change src/a.ts so it does the thing.' });

    await resync(database, boardId, repo, judgeReturning([]));

    expect(asked[0]?.map((card) => card.cardId)).toEqual([id]);
  });

  it('leaves running, archived and finished cards out of it', async () => {
    addCard({ title: 'Running', status: 'running' });
    addCard({ title: 'Archived', status: 'abandoned', archived: true });
    addCard({ title: 'Filed', status: 'abandoned', column: 'Done' });

    const report = await resync(database, boardId, repo, judgeReturning([]));

    // A verdict about a card being worked on right now is out of date before
    // it is written, and the other two are already where they belong.
    expect(asked).toEqual([]);
    expect(report.candidates).toBe(0);
    expect(report.note).toContain('Nothing to catch up on.');
  });

  it('puts every candidate in one call rather than one call each', async () => {
    addCard({ title: 'One', status: 'abandoned' });
    addCard({ title: 'Two', status: 'abandoned' });
    addCard({ title: 'Three', status: 'abandoned' });

    await resync(database, boardId, repo, judgeReturning([]));

    // Measured against this repository: 87k input tokens for one card, 186k
    // for two. A sweep shares the agent's orientation and its prompt cache
    // across the column; three separate calls would pay for both three times.
    expect(asked).toHaveLength(1);
    expect(asked[0]).toHaveLength(3);
  });
});

describe('what a verdict is allowed to do', () => {
  it('files a finished card in the terminal column, and marks it done', async () => {
    const id = addCard({ title: 'Finished', status: 'abandoned' });

    const report = await resync(
      database,
      boardId,
      repo,
      judgeReturning([
        { cardId: id, state: 'done', evidence: 'Implemented in src/a.ts.', commits: ['abc1234'] },
      ]),
    );

    expect(columnOf(id)).toBe('Done');
    // The status moves with it. A card sitting in Done still marked idle is a
    // card the dispatch queue will offer again.
    expect(cardRow(id).status).toBe('done');
    expect(report.findings[0]?.movedTo).toBe('Done');
    expect(report.findings[0]?.evidence).toBe('Implemented in src/a.ts.');
  });

  it('sends a partial one to the review gate without resolving it', async () => {
    const id = addCard({ title: 'Partial', status: 'abandoned' });

    await resync(
      database,
      boardId,
      repo,
      judgeReturning([
        { cardId: id, state: 'review', evidence: 'Half of it is there.', commits: [] },
      ]),
    );

    expect(columnOf(id)).toBe('Needs Review');
    // Untouched: the operator's verdict is what resolves a card at the gate,
    // and writing one here would be the board casting it for them.
    expect(cardRow(id).status).toBe('abandoned');
  });

  it('leaves a card alone when the agent found no trace of the work', async () => {
    const id = addCard({ title: 'Untouched', status: 'abandoned' });

    const report = await resync(
      database,
      boardId,
      repo,
      judgeReturning([
        { cardId: id, state: 'unfinished', evidence: 'Nothing in the repository.', commits: [] },
      ]),
    );

    expect(columnOf(id)).toBe('Intake');
    expect(report.findings[0]?.movedTo).toBeNull();
    expect(report.note).toContain('left alone');
  });

  it('ignores a verdict about a card it never asked about', async () => {
    const real = addCard({ title: 'Real', status: 'abandoned' });
    const bystander = addCard({ title: 'Bystander', column: 'Done' });

    const report = await resync(
      database,
      boardId,
      repo,
      judgeReturning([
        { cardId: real, state: 'unfinished', evidence: 'No.', commits: [] },
        // Not a candidate, so not the agent's to move - and an id it invented
        // outright would arrive looking exactly like this.
        { cardId: bystander, state: 'done', evidence: 'Yes.', commits: [] },
      ]),
    );

    expect(report.findings).toHaveLength(1);
    expect(cardRow(bystander).status).toBe('idle');
  });

  it('reports without moving anything when asked only to look', async () => {
    const id = addCard({ title: 'Finished', status: 'abandoned' });

    const report = await resync(
      database,
      boardId,
      repo,
      judgeReturning([{ cardId: id, state: 'done', evidence: 'It is there.', commits: [] }]),
      { apply: false },
    );

    expect(columnOf(id)).toBe('Intake');
    expect(report.findings[0]?.movedTo).toBe('Done');
    expect(report.note).toContain('Would move');
  });
});

describe('one card the operator points at', () => {
  it('asks about exactly that card, however it looks', async () => {
    addCard({ title: 'Other', status: 'abandoned' });
    // Not a candidate by any heuristic: idle, names no file, never run.
    const pointed = addCard({ title: 'Pointed at' });

    await resync(database, boardId, repo, judgeReturning([]), { cardId: pointed });

    // Pointing at a card is a better signal than any filter we could write.
    expect(asked[0]?.map((card) => card.cardId)).toEqual([pointed]);
  });

  it('says so plainly when the card is not on this board', async () => {
    const report = await resync(database, boardId, repo, judgeReturning([]), {
      cardId: 'card-nowhere',
    });

    expect(asked).toEqual([]);
    expect(report.note).toBe('No such card on this board.');
  });
});

describe('when the agent cannot answer', () => {
  it('carries the reason back instead of failing the request', async () => {
    const id = addCard({ title: 'Finished', status: 'abandoned' });
    const judge = vi.fn(() => Promise.reject(new Error('usage limit reached')));

    const report = await resync(database, boardId, repo, judge as unknown as ResyncJudge);

    // The CLI's own sentence, intact. "usage limit reached" and "not logged
    // in" are the two an operator has to be able to read to act on.
    expect(report.error).toBe('usage limit reached');
    expect(report.findings).toEqual([]);
    expect(columnOf(id)).toBe('Intake');
    expect(report.note).toContain('nothing was moved');
  });
});

describe('what the sweep cost', () => {
  it('reports the tokens the agent spent', async () => {
    const id = addCard({ title: 'Finished', status: 'abandoned' });

    const report = await resync(
      database,
      boardId,
      repo,
      judgeReturning([{ cardId: id, state: 'unfinished', evidence: 'No.', commits: [] }], {
        inputTokens: 87_764,
        outputTokens: 757,
      }),
    );

    expect(report.tokensSpent).toBe(88_521);
    expect(report.model).toBe('test-model');
  });

  it('says nothing rather than zero when the CLI reported no usage', async () => {
    addCard({ title: 'Finished', status: 'abandoned' });

    const report = await resync(database, boardId, repo, judgeReturning([]));

    // Zero would read as a free sweep, which is a different claim from "the
    // CLI did not tell us".
    expect(report.tokensSpent).toBeNull();
  });
});

describe('a board with nothing suspect on it', () => {
  it('does not spend anything to find that out', async () => {
    addCard({ title: 'Ordinary' });

    const report = await resync(database, boardId, repo, judgeReturning([]));

    expect(asked).toEqual([]);
    expect(report.candidates).toBe(0);
  });
});
