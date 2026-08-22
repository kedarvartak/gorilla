import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';

import { buildApp } from '../src/server/app.js';
import { createCard, updateCard } from '../src/server/api/cards.js';
import { createDefaultColumns } from '../src/server/cards/defaults.js';
import { openDatabase, type DatabaseHandle } from '../src/server/db/client.js';
import { boards, cards } from '../src/server/db/schema.js';

/**
 * What opening a card costs (T73).
 *
 * The route grew all day. It now reads the diff, forecasts a merge, checks
 * claim against reality, assesses staleness against every merged card, and
 * asks git for the worktree status - seven subprocesses, plus one per merged
 * card.
 *
 * This is a bound, not a benchmark. It exists so that adding an eighth git
 * call to the busiest read in the product is a decision somebody makes rather
 * than one that happens, and the number is deliberately loose: a tight one on
 * shared CI hardware fails for reasons that have nothing to do with the code.
 */

const MERGED_CARDS = 14;

/** Loose on purpose. A regression that matters is a multiple of this. */
const BUDGET_MS = 2_000;

let dir: string;
let repo: string;
let database: DatabaseHandle;
let app: FastifyInstance;
let cardId: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'gorilla-detail-budget-'));
  repo = join(dir, 'repo');
  execFileSync('git', ['init', '-q', repo]);
  execFileSync('git', ['config', 'user.email', 't@example.com'], { cwd: repo });
  execFileSync('git', ['config', 'user.name', 'T'], { cwd: repo });
  writeFileSync(join(repo, 'a.txt'), 'a\n');
  execFileSync('git', ['add', '.'], { cwd: repo });
  execFileSync('git', ['commit', '-qm', 'initial'], { cwd: repo });

  database = openDatabase({ path: join(dir, 'd.db') });
  database.db.insert(boards).values({ id: 'b', name: 'b', cwd: repo, createdAt: 1 }).run();
  createDefaultColumns(database.db, 'b');

  // Every merged card costs the route one more git call, so the shape of the
  // board matters more than the size of the diff.
  for (let index = 0; index < MERGED_CARDS; index += 1) {
    const merged = createCard(database, { boardId: 'b', title: `merged ${String(index)}` });
    database.db
      .update(cards)
      .set({ mergedAt: Date.now(), mergedBranch: `gorilla/gone-${String(index)}` })
      .where(eq(cards.id, merged.id))
      .run();
  }

  cardId = createCard(database, { boardId: 'b', title: 'the one being opened' }).id;
  updateCard(database, cardId, { guardrails: { verify: 'true' } });

  app = buildApp({ database, logger: false });
  await app.ready();
});

afterEach(async () => {
  await app.close();
  database.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('opening a card', () => {
  it(`answers within ${String(BUDGET_MS)}ms with ${String(MERGED_CARDS)} merged cards`, async () => {
    // Warmed first: the first call in a process pays for git's own start-up
    // and for opening the repository, which is not what this is measuring.
    await app.inject({ method: 'GET', url: `/api/cards/${cardId}/detail` });

    const started = Date.now();
    const response = await app.inject({ method: 'GET', url: `/api/cards/${cardId}/detail` });
    const elapsed = Date.now() - started;

    expect(response.statusCode).toBe(200);
    expect(elapsed, `opening a card took ${String(elapsed)}ms`).toBeLessThan(BUDGET_MS);
  });
});
