/* eslint-disable no-console */
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createCard, getCard, moveCard } from '../src/server/api/cards.js';
import { createDefaultColumns } from '../src/server/cards/defaults.js';
import { openDatabase, type DatabaseHandle } from '../src/server/db/client.js';
import { Dispatcher } from '../src/server/dispatch/dispatcher.js';
import { PendingBindings } from '../src/server/binding/pending.js';
import { boards, columns, plans } from '../src/server/db/schema.js';
import { REPORT_PATH } from '../src/server/review/contract.js';
import { approvePlan, batchStatus } from '../src/server/review/batch.js';

/**
 * One task end-to-end: create → approve → dispatch → integrate → batch merge.
 *
 * This tests the full flow of the revamp in one go.
 */

let dir: string;
let repo: string;
let handle: DatabaseHandle;
let dispatcher: Dispatcher;

const BOARD = 'board-1';

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
}

function fakeClaude(script: string, options: { report?: boolean } = {}): string {
  const path = join(dir, `fake-${Math.random().toString(36).slice(2)}.sh`);
  const report =
    options.report === false
      ? ''
      : `mkdir -p .gorilla && cat > ${REPORT_PATH} <<'JSON'
{
  "summary": "Completed the work as requested.",
  "files": [{"path": "app.txt", "why": "The change the task asked for."}],
  "verification": {"how": "npm test", "result": "passed", "evidence": "test.log"},
  "outstanding": []
}
JSON
`;

  writeFileSync(path, `#!/usr/bin/env bash\n${report}${script}\n`, 'utf8');
  chmodSync(path, 0o755);
  return path;
}

function columnNamed(name: string): string {
  const found = handle.db.select().from(columns).where(eq(columns.name, name)).get();
  if (found === undefined) throw new Error(`no column ${name}`);
  return found.id;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gorilla-single-'));
  repo = join(dir, 'repo');

  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  execFileSync('git', ['config', 'user.email', 't@example.com'], { cwd: repo });
  execFileSync('git', ['config', 'user.name', 'T'], { cwd: repo });
  writeFileSync(join(repo, 'app.txt'), 'original\n');
  git('add', '.');
  git('commit', '-qm', 'initial');

  handle = openDatabase({ path: join(dir, 'single.db') });
  handle.db.insert(boards).values({ id: BOARD, name: 'test', cwd: repo, createdAt: 1 }).run();
  createDefaultColumns(handle.db, BOARD);

  dispatcher = new Dispatcher(handle, new PendingBindings());
});

afterEach(async () => {
  await dispatcher.shutdown();
  handle.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('one task end-to-end', () => {
  it('goes from create → dispatch → batch merge clean', async () => {
    // 1. Create a card with a plan
    const planId = 'plan-1';
    handle.db
      .insert(plans)
      .values({
        id: planId,
        boardId: BOARD,
        prompt: 'Fix the typo in app.txt',
        createdAt: 1,
      })
      .run();

    const card = createCard(handle, {
      boardId: BOARD,
      title: 'Fix typo in app.txt',
      body: 'There is a typo: change "original" to "corrected"',
      goalCondition: 'The file contains "corrected", verified by `grep corrected app.txt`',
      planId,
    });

    // 2. Move to Ready
    moveCard(handle, card.id, columnNamed('Ready'), 0);

    // 3. Approve the plan (cuts batch branch)
    const approved = await approvePlan(handle, planId);

    // 4. The agent does work: edits app.txt and writes report
    dispatcher.useExecutable(fakeClaude('echo "corrected" > app.txt'));

    // 5. Dispatch the card
    const run = await dispatcher.dispatchIsolated(BOARD, card.id);
    if (run) {
      await run.result;
    }

    // 6. Wait for settlement
    await vi.waitFor(
      () => {
        const c = getCard(handle, card.id);
        expect(c.completionReport).not.toBeNull();
        expect(c.integratedAt).not.toBeNull();
      },
      { timeout: 5000 },
    );

    const settled = getCard(handle, card.id);

    // 7. Check batch status
    const status = batchStatus(handle, planId);

    // 8. Verify: card is integrated, batch has the change, ready to merge
    expect(settled.status).toBe('awaiting-review');
    expect(settled.integratedAt).not.toBeNull();
    expect(status.integrated).toBe(1);

    // The batch branch has the change
    const batchLog = git('log', '--oneline', approved.integrationBranch);
    expect(batchLog).toContain('Fix typo');
  });
});
