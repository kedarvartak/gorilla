import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createCard, updateCard } from '../src/server/api/cards.js';
import { createDefaultColumns } from '../src/server/cards/defaults.js';
import { openDatabase, type DatabaseHandle } from '../src/server/db/client.js';
import { boards } from '../src/server/db/schema.js';
import { statusCommand } from '../src/cli/commands/status.js';

/**
 * What the board is doing, from the shell (T55, T58).
 *
 * An unattended board is one nobody is watching, so "is it still going" has to
 * be answerable without opening the interface.
 */

let dir: string;
let dbPath: string;
let handle: DatabaseHandle;
const BOARD = 'board-1';

/** A port nothing is listening on, which is the offline case. */
const DEAD_PORT = '4399';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gorilla-status-'));
  dbPath = join(dir, 'status.db');
  handle = openDatabase({ path: dbPath });
  handle.db.insert(boards).values({ id: BOARD, name: 'the board', cwd: dir, createdAt: 1 }).run();
  createDefaultColumns(handle.db, BOARD);
});

afterEach(() => {
  handle.close();
  rmSync(dir, { recursive: true, force: true });
});

async function status(...args: string[]) {
  return statusCommand.run(['--port', DEAD_PORT, '--db', dbPath, ...args]);
}

describe('with no board serving', () => {
  it('says so before anything else', async () => {
    const result = await status();

    // The most important fact. An empty queue and a dead board look identical
    // in a count, and only one of them is fine.
    expect(result.stdout).toContain('nothing is dispatching anything');
  });

  it('exits non-zero', async () => {
    // A zero here would let a cron job report a healthy night to an operator
    // whose board died at midnight.
    expect((await status()).exitCode).toBe(1);
  });

  it('still reports what was last written down', async () => {
    createCard(handle, { boardId: BOARD, title: 'waiting' });

    expect((await status()).stdout).toContain('1 queued');
  });

  it('labels a card left marked running as cut off', async () => {
    const card = createCard(handle, { boardId: BOARD, title: 'was running' });
    updateCard(handle, card.id, { status: 'running' });

    // With no server there is nothing supervising it. Reporting it as running
    // without saying so would describe work that is not happening.
    expect((await status()).stdout).toContain('cut off');
  });

  it('answers in json when asked', async () => {
    const parsed = JSON.parse((await status('--json')).stdout) as {
      serving: boolean;
      boards: unknown[];
    };

    expect(parsed.serving).toBe(false);
    expect(parsed.boards).toHaveLength(1);
  });
});
