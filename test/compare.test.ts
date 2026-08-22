import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';

import { createCard } from '../src/server/api/cards.js';
import { createDefaultColumns } from '../src/server/cards/defaults.js';
import { openDatabase, type DatabaseHandle } from '../src/server/db/client.js';
import { boards, runs } from '../src/server/db/schema.js';
import { compareCards, describeComparison, type Candidate } from '../src/server/review/compare.js';
import { WorktreeManager } from '../src/server/worktree/manager.js';

/**
 * Two attempts at the same work, side by side (T61).
 *
 * The backlog asked for N runs of one card on N branches. That means re-keying
 * the worktree path, the lease primary key and the runs table - the three
 * pieces whose invariants stop two agents sharing a checkout. Cloning already
 * produces two branches; the comparison was what was missing.
 */

let dir: string;
let repo: string;
let handle: DatabaseHandle;
let manager: WorktreeManager;
const BOARD = 'board-1';

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
}

function card(title: string): string {
  return createCard(handle, { boardId: BOARD, title }).id;
}

async function attempt(cardId: string, branch: string, file: string): Promise<void> {
  const created = await manager.create(cardId, branch);
  if (!created.ok) throw new Error(created.reason);

  const workspace = manager.workspaceFor(cardId);
  if (workspace === undefined) throw new Error('no workspace');

  writeFileSync(join(workspace.path, file), 'changed\n');
  execFileSync('git', ['add', '.'], { cwd: workspace.path });
  execFileSync('git', ['commit', '-qm', 'the attempt'], { cwd: workspace.path });
}

function spent(cardId: string, tokens: number | null): void {
  handle.db
    .insert(runs)
    .values({
      id: randomUUID(),
      boardId: BOARD,
      cardId,
      sessionId: randomUUID(),
      startedAt: Date.now(),
      cwd: repo,
      ...(tokens === null ? {} : { inputTokens: tokens, costSource: 'result' as const }),
    })
    .run();
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gorilla-compare-'));
  repo = join(dir, 'repo');
  execFileSync('git', ['init', '-q', repo]);
  execFileSync('git', ['config', 'user.email', 't@example.com'], { cwd: repo });
  execFileSync('git', ['config', 'user.name', 'T'], { cwd: repo });
  writeFileSync(join(repo, 'one.txt'), 'one\n');
  writeFileSync(join(repo, 'two.txt'), 'two\n');
  git('add', '.');
  git('commit', '-qm', 'initial');

  handle = openDatabase({ path: join(dir, 'c.db') });
  handle.db.insert(boards).values({ id: BOARD, name: 'b', cwd: repo, createdAt: 1 }).run();
  createDefaultColumns(handle.db, BOARD);
  manager = new WorktreeManager(repo);
});

afterEach(() => {
  handle.close();
  rmSync(dir, { recursive: true, force: true });
});

async function compare(cardIds: string[], verify: Record<string, string> = {}) {
  return compareCards({
    sqlite: handle.sqlite,
    repoCwd: repo,
    manager,
    cardIds,
    verifyFor: (cardId) => verify[cardId] ?? null,
  });
}

describe('putting two attempts beside each other', () => {
  it('reports what each one changed', async () => {
    const first = card('attempt one');
    const second = card('attempt two');
    await attempt(first, 'one', 'one.txt');
    await attempt(second, 'two', 'one.txt');

    const comparison = await compare([first, second]);

    expect(comparison.candidates).toHaveLength(2);
    expect(comparison.candidates[0]?.diff.files.map((file) => file.path)).toEqual(['one.txt']);
  });

  it('names the files both touched', async () => {
    const first = card('attempt one');
    const second = card('attempt two');
    await attempt(first, 'one', 'one.txt');
    await attempt(second, 'two', 'one.txt');

    // Where two alternatives disagree is the first thing to read.
    expect((await compare([first, second])).shared).toEqual(['one.txt']);
  });

  it('says when they may not be alternatives at all', async () => {
    const first = card('attempt one');
    const second = card('something else');
    await attempt(first, 'one', 'one.txt');
    await attempt(second, 'two', 'two.txt');

    expect((await compare([first, second])).note).toContain('may not be alternatives');
  });

  it('skips a card that does not exist rather than failing', async () => {
    const first = card('attempt one');
    await attempt(first, 'one', 'one.txt');

    expect((await compare([first, 'no-such-card'])).candidates).toHaveLength(1);
  });
});

describe('what it costs', () => {
  it('reports null rather than zero when nothing recorded usage', async () => {
    const first = card('attempt one');
    spent(first, null);

    // A candidate that looks free next to one that cost 40k would win an
    // argument it did not earn.
    expect((await compare([first, card('other')])).candidates[0]?.tokens).toBeNull();
  });

  it('adds up what was recorded', async () => {
    const first = card('attempt one');
    spent(first, 1_000);
    spent(first, 500);

    expect((await compare([first, card('other')])).candidates[0]?.tokens).toBe(1_500);
  });
});

describe('what it will not say', () => {
  function candidate(over: Partial<Candidate>): Candidate {
    return {
      cardId: 'x',
      title: 'a card',
      status: 'awaiting-review',
      branch: 'b',
      verify: null,
      diff: { files: [], insertions: 0, deletions: 0, readable: true },
      tokens: null,
      ...over,
    };
  }

  it('never picks a winner', () => {
    const note = describeComparison(
      [
        candidate({ title: 'one', verify: 'passed' }),
        candidate({ title: 'two', verify: 'passed' }),
      ],
      ['a.ts'],
    );

    // The board can see which passed its verify. It cannot see which one an
    // operator will want to maintain, and picking would be making the
    // judgement they opened this screen to make.
    expect(note).not.toContain('recommend');
    expect(note).toContain('Both pass');
  });

  it('says when only one passes, without saying to take it', () => {
    const note = describeComparison(
      [
        candidate({ title: 'one', verify: 'passed' }),
        candidate({ title: 'two', verify: 'failed' }),
      ],
      ['a.ts'],
    );

    expect(note).toContain('Only "one" passes');
  });

  it('refuses to compare fewer than two', () => {
    expect(describeComparison([candidate({})], [])).toContain('name two cards');
  });
});
