import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resync } from '../src/server/cards/resync.js';
import { createDefaultColumns } from '../src/server/cards/defaults.js';
import { openDatabase, type DatabaseHandle } from '../src/server/db/client.js';
import { boards, cards, columns, runs } from '../src/server/db/schema.js';
import { eq } from 'drizzle-orm';

/**
 * Catching up with work done in another harness.
 *
 * The interesting assertions here are the refusals. Confirming a card that is
 * finished is easy; the failure that matters is confirming one that is not,
 * because the board would be moving the operator's work on a guess and saying
 * it had evidence.
 */

let dir: string;
let repo: string;
let database: DatabaseHandle;
let boardId: string;

/**
 * A fixed clock.
 *
 * Git records commit times to the second, so a test that leans on `Date.now()`
 * puts the setup commit and the card in the same second and cannot say which
 * came first. Written out explicitly, the order is the thing being tested
 * rather than a race the suite happens to win.
 */
const T0 = 1_700_000_000;
const CARD_AT = (T0 + 100) * 1000;

function git(...args: string[]): void {
  execFileSync('git', args, { cwd: repo });
}

/** A commit touching exactly these files, at a stated moment. */
function commit(message: string, files: Record<string, string>, atSeconds = T0): void {
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(join(repo, path, '..'), { recursive: true });
    writeFileSync(join(repo, path), body);
  }
  const when = new Date(atSeconds * 1000).toISOString();
  git('add', '.');
  execFileSync('git', ['commit', '-qm', message, '--date', when], {
    cwd: repo,
    env: { ...process.env, GIT_COMMITTER_DATE: when },
  });
}

function addCard(over: { title: string; body?: string; createdAt?: number }): string {
  const id = `card-${over.title.replace(/\W/g, '')}`;
  const intake = database.db
    .select()
    .from(columns)
    .where(eq(columns.boardId, boardId))
    .all()
    .find((column) => column.name === 'Intake');

  const at = over.createdAt ?? CARD_AT;
  database.db
    .insert(cards)
    .values({
      id,
      boardId,
      columnId: intake?.id ?? '',
      title: over.title,
      body: over.body ?? '',
      position: at,
      status: 'idle',
      createdAt: at,
      updatedAt: at,
    })
    .run();
  return id;
}

function columnOf(cardId: string): string {
  const card = database.db.select().from(cards).where(eq(cards.id, cardId)).get();
  const column = database.db
    .select()
    .from(columns)
    .where(eq(columns.id, card?.columnId ?? ''))
    .get();
  return column?.name ?? '';
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gorilla-resync-'));
  repo = join(dir, 'repo');
  mkdirSync(repo);
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 'T');

  database = openDatabase({ path: join(dir, 'resync.db') });
  boardId = 'board-1';
  database.db
    .insert(boards)
    .values({ id: boardId, name: 'b', cwd: repo, createdAt: Date.now() })
    .run();
  createDefaultColumns(database.db, boardId);

  // The state every card here is written against.
  commit('initial', { 'src/a.ts': 'export const a = 1;\n', 'src/b.ts': 'export const b = 1;\n' });
});

afterEach(() => {
  database.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('a card whose work happened somewhere else', () => {
  it('moves to review when one commit covers everything it names', async () => {
    const id = addCard({ title: 'Rework a and b', body: 'Change `src/a.ts` and `src/b.ts`.' });

    commit(
      'did the thing',
      { 'src/a.ts': 'export const a = 2;\n', 'src/b.ts': 'export const b = 2;\n' },
      T0 + 200,
    );

    const report = await resync(database, boardId, repo);

    expect(report.moved.map((finding) => finding.title)).toEqual(['Rework a and b']);
    expect(columnOf(id)).toBe('Needs Review');
    // The evidence travels with the verdict: a move an operator cannot check
    // is a move they have to take on trust.
    expect(report.moved[0]?.commits[0]?.subject).toBe('did the thing');
  });

  it('is not confirmed when its files changed separately', async () => {
    // The rule this replaced. Two unrelated commits touching one file each is
    // what ordinary churn looks like in any repository that is being worked in,
    // and counting it confirmed an abandoned card on a real board.
    const id = addCard({ title: 'Rework a and b', body: 'Change `src/a.ts` and `src/b.ts`.' });

    commit('unrelated work on a', { 'src/a.ts': 'export const a = 3;\n' }, T0 + 200);
    commit('unrelated work on b', { 'src/b.ts': 'export const b = 3;\n' }, T0 + 300);

    const report = await resync(database, boardId, repo);

    expect(report.moved).toHaveLength(0);
    expect(report.unconfirmed.map((finding) => finding.title)).toEqual(['Rework a and b']);
    expect(columnOf(id)).toBe('Intake');
  });

  it('is not confirmed by commits that predate it', async () => {
    // Otherwise every card is confirmed the moment it is written: the state it
    // was written against is, by definition, already in the history.
    commit(
      'work that came first',
      { 'src/a.ts': 'export const a = 4;\n', 'src/b.ts': 'export const b = 4;\n' },
      T0 + 50,
    );

    addCard({ title: 'Rework a and b', body: 'Change `src/a.ts` and `src/b.ts`.' });

    const report = await resync(database, boardId, repo);
    expect(report.moved).toHaveLength(0);
  });

  it('cannot be confirmed by a directory alone', async () => {
    // `src/` in a scope is permission to work there, not a claim about every
    // file under it. Treated as evidence it matches every commit in the repo.
    const id = addCard({ title: 'Something in src', body: 'Work somewhere under `src/`.' });

    commit('anything at all', { 'src/a.ts': 'export const a = 5;\n' }, T0 + 200);

    const report = await resync(database, boardId, repo);
    expect(report.moved).toHaveLength(0);
    expect(columnOf(id)).toBe('Intake');
  });
});

describe('what a resync leaves alone', () => {
  it('ignores a card that has already run here', async () => {
    // The board saw this one work. Whatever state it is in, it is not a card
    // whose history the board missed.
    const id = addCard({ title: 'Rework a and b', body: 'Change `src/a.ts` and `src/b.ts`.' });
    database.db
      .insert(runs)
      .values({
        id: 'run-1',
        boardId,
        cardId: id,
        sessionId: 's1',
        cwd: repo,
        startedAt: CARD_AT,
      })
      .run();

    commit(
      'did the thing',
      { 'src/a.ts': 'export const a = 6;\n', 'src/b.ts': 'export const b = 6;\n' },
      T0 + 200,
    );

    const report = await resync(database, boardId, repo);
    expect(report.candidates).toBe(0);
    expect(columnOf(id)).toBe('Intake');
  });

  it('moves nothing when asked only to look', async () => {
    const id = addCard({ title: 'Rework a and b', body: 'Change `src/a.ts` and `src/b.ts`.' });
    commit(
      'did the thing',
      { 'src/a.ts': 'export const a = 7;\n', 'src/b.ts': 'export const b = 7;\n' },
      T0 + 200,
    );

    const report = await resync(database, boardId, repo, { apply: false });

    expect(report.moved).toHaveLength(1);
    expect(report.note).toContain('Would move');
    expect(columnOf(id)).toBe('Intake');
  });

  it('says so plainly when there is nothing to catch up on', async () => {
    const report = await resync(database, boardId, repo);
    expect(report.candidates).toBe(0);
    expect(report.note).toContain('Nothing to catch up on');
  });

  it('never claims a card is done, only that somebody should look', async () => {
    addCard({ title: 'Rework a and b', body: 'Change `src/a.ts` and `src/b.ts`.' });
    commit(
      'did the thing',
      { 'src/a.ts': 'export const a = 8;\n', 'src/b.ts': 'export const b = 8;\n' },
      T0 + 200,
    );

    const report = await resync(database, boardId, repo);

    // The whole reason the destination is the review gate and not Done.
    expect(report.note).toContain('still a judgement');
    expect(report.movedTo).toBe('Needs Review');
  });
});
