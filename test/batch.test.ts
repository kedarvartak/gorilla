import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createCard } from '../src/server/api/cards.js';
import { createDefaultColumns } from '../src/server/cards/defaults.js';
import { openDatabase, type DatabaseHandle } from '../src/server/db/client.js';
import { boards, cards, plans } from '../src/server/db/schema.js';
import {
  approvePlan,
  batchStatus,
  BatchError,
  integrateCard,
  mergeBatch,
} from '../src/server/review/batch.js';

/**
 * The batch branch.
 *
 * The claim under test is that an approved plan produces one reviewable
 * result rather than five branches: cards integrate as they finish, a
 * conflict surfaces against the card that caused it, and the step onto the
 * project's own branch stays a person's decision.
 */

let dir: string;
let repo: string;
let handle: DatabaseHandle;

const BOARD = 'board-1';
const PLAN = 'plan-1';

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
}

/** A card with a branch of its own, as a finished run would leave it. */
function finishedCard(title: string, file: string, contents: string): string {
  const card = createCard(handle, { boardId: BOARD, title, planId: PLAN });

  const branch = `gorilla/${card.id.slice(0, 8)}`;
  git('checkout', '-q', '-b', branch, 'main');
  writeFileSync(join(repo, file), contents);
  git('add', '.');
  git('commit', '-qm', title);
  git('checkout', '-q', 'main');

  handle.db
    .update(cards)
    .set({ status: 'awaiting-review', mergedBranch: branch })
    .where(eq(cards.id, card.id))
    .run();

  return card.id;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gorilla-batch-'));
  repo = join(dir, 'repo');

  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  execFileSync('git', ['config', 'user.email', 't@example.com'], { cwd: repo });
  execFileSync('git', ['config', 'user.name', 'T'], { cwd: repo });
  writeFileSync(join(repo, 'app.txt'), 'original\n');
  git('add', '.');
  git('commit', '-qm', 'initial');

  handle = openDatabase({ path: join(dir, 'batch.db') });
  handle.db.insert(boards).values({ id: BOARD, name: 'b', cwd: repo, createdAt: 1 }).run();
  createDefaultColumns(handle.db, BOARD);
  handle.db
    .insert(plans)
    .values({ id: PLAN, boardId: BOARD, prompt: 'password reset flow', createdAt: 1 })
    .run();
});

afterEach(() => {
  handle.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('approving a plan', () => {
  it('cuts one branch the whole batch integrates onto', async () => {
    const approved = await approvePlan(handle, PLAN);

    expect(approved.integrationBranch).toContain('gorilla/batch/password-reset-flow');
    expect(git('branch', '--list', approved.integrationBranch)).not.toBe('');

    const plan = handle.db.select().from(plans).where(eq(plans.id, PLAN)).get();
    expect(plan?.approvedAt).not.toBeNull();
  });

  it('refuses to approve the same plan twice', async () => {
    await approvePlan(handle, PLAN);
    await expect(approvePlan(handle, PLAN)).rejects.toBeInstanceOf(BatchError);
  });
});

describe('integrating cards as they finish', () => {
  it('merges a finished card onto the batch branch', async () => {
    await approvePlan(handle, PLAN);
    const id = finishedCard('Reset email endpoint', 'email.txt', 'sends\n');

    const report = await integrateCard(handle, id);

    expect(report?.clean).toBe(true);
    expect(
      handle.db.select().from(cards).where(eq(cards.id, id)).get()?.integratedAt,
    ).not.toBeNull();
  });

  it('does nothing for a card whose plan was never approved', async () => {
    const id = finishedCard('Unapproved', 'email.txt', 'sends\n');

    expect(await integrateCard(handle, id)).toBeNull();
  });

  it('surfaces a conflict against the card that caused it, not the batch', async () => {
    await approvePlan(handle, PLAN);

    const first = finishedCard('First writer', 'shared.txt', 'from the first card\n');
    const second = finishedCard('Second writer', 'shared.txt', 'from the second card\n');

    expect((await integrateCard(handle, first))?.clean).toBe(true);

    const report = await integrateCard(handle, second);
    expect(report?.clean).toBe(false);
    expect(report?.stoppedAt?.outcome).toBe('conflicted');

    // The first card keeps its integration: a conflict is between two cards
    // and does not undo the one that landed cleanly.
    const firstRow = handle.db.select().from(cards).where(eq(cards.id, first)).get();
    const secondRow = handle.db.select().from(cards).where(eq(cards.id, second)).get();
    expect(firstRow?.integratedAt).not.toBeNull();
    expect(secondRow?.integratedAt).toBeNull();
  });
});

describe('what the board says about a batch', () => {
  it('counts what is integrated against what the plan holds', async () => {
    await approvePlan(handle, PLAN);
    const first = finishedCard('One', 'a.txt', 'a\n');
    finishedCard('Two', 'b.txt', 'b\n');
    await integrateCard(handle, first);

    const status = batchStatus(handle, PLAN);

    expect(status.total).toBe(2);
    expect(status.integrated).toBe(1);
    expect(status.headline).toBe('1 of 2 tasks integrated');
  });

  it('keeps what needs a person out of the progress count', async () => {
    await approvePlan(handle, PLAN);
    const id = finishedCard('Stuck', 'a.txt', 'a\n');

    handle.db
      .update(cards)
      .set({
        status: 'blocked',
        completionReport: JSON.stringify({
          outstanding: ['Which provider should send the email?'],
        }),
      })
      .where(eq(cards.id, id))
      .run();

    const status = batchStatus(handle, PLAN);

    expect(status.integrated).toBe(0);
    expect(status.needsYou).toEqual([
      { cardId: id, title: 'Stuck', why: 'Which provider should send the email?' },
    ]);
  });
});

describe('the batch onto the project branch', () => {
  it('lands as one merge and records where it went', async () => {
    await approvePlan(handle, PLAN);
    const id = finishedCard('One', 'a.txt', 'a\n');
    await integrateCard(handle, id);

    const report = await mergeBatch(handle, PLAN, { into: 'main' });

    expect(report.clean).toBe(true);
    expect(git('log', '--oneline', 'main')).toContain('One');

    const plan = handle.db.select().from(plans).where(eq(plans.id, PLAN)).get();
    expect(plan?.mergedInto).toBe('main');
    expect(plan?.mergedAt).not.toBeNull();
  });

  it('refuses when there is no batch branch to merge', async () => {
    await expect(mergeBatch(handle, PLAN, { into: 'main' })).rejects.toBeInstanceOf(BatchError);
  });
});
