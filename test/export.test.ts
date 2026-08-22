import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createCard, updateCard } from '../src/server/api/cards.js';
import { renderBoardExport } from '../src/server/board-export.js';
import { createDefaultColumns } from '../src/server/cards/defaults.js';
import { exportCommand } from '../src/cli/commands/export.js';
import { schemaTooOld } from '../src/cli/commands/read-only.js';
import { openDatabase, type DatabaseHandle } from '../src/server/db/client.js';
import { boards, invariants } from '../src/server/db/schema.js';
import { randomUUID } from 'node:crypto';

/**
 * The whole board as one file (T54).
 *
 * A board is a screen, and a screen cannot be attached to anything. Read from
 * the database rather than a running server, because one of the times this is
 * most wanted is when nothing is serving.
 */

let dir: string;
let dbPath: string;
let handle: DatabaseHandle;
const BOARD = 'board-1';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gorilla-export-'));
  dbPath = join(dir, 'e.db');
  handle = openDatabase({ path: dbPath });
  handle.db.insert(boards).values({ id: BOARD, name: 'the board', cwd: dir, createdAt: 1 }).run();
  createDefaultColumns(handle.db, BOARD);
});

afterEach(() => {
  handle.close();
  rmSync(dir, { recursive: true, force: true });
});

function render(): string {
  return renderBoardExport(handle.sqlite, BOARD, 1_700_000_000_000) ?? '';
}

describe('what the file says', () => {
  it('names the board and where it lives', () => {
    expect(render()).toContain('# the board');
    expect(render()).toContain(dir);
  });

  it('carries its own caveat about how old the state is', () => {
    // A file outlives the moment it was made, and nothing else in it says how
    // stale the in-flight state might be.
    expect(render()).toContain('last state written down');
  });

  it('says a card has no goal rather than saying nothing', () => {
    createCard(handle, { boardId: BOARD, title: 'no goal' });

    // A reader scanning for why nothing happened should not have to infer it
    // from an absent line.
    expect(render()).toContain('cannot be dispatched');
  });

  it('carries the guardrails that constrain a card', () => {
    const card = createCard(handle, { boardId: BOARD, title: 'constrained' });
    updateCard(handle, card.id, {
      guardrails: { verify: 'npm test', prohibit: ['src/db/schema.ts'] },
    });

    expect(render()).toContain('npm test');
    expect(render()).toContain('src/db/schema.ts');
  });

  it('carries the project rules', () => {
    handle.db
      .insert(invariants)
      .values({
        id: randomUUID(),
        boardId: BOARD,
        statement: 'Migrations are additive.',
        createdAt: 1,
      })
      .run();

    expect(render()).toContain('Migrations are additive.');
  });

  it('says so plainly when a board has nothing on it', () => {
    expect(render()).toContain('no cards');
  });

  it('answers nothing for a board that does not exist', () => {
    expect(renderBoardExport(handle.sqlite, 'no-such-board', 1)).toBeNull();
  });
});

describe('the command', () => {
  it('writes to a file when asked', async () => {
    createCard(handle, { boardId: BOARD, title: 'a card' });
    const out = join(dir, 'board.md');

    const result = await exportCommand.run(['--db', dbPath, '--out', out]);

    expect(result.exitCode).toBe(0);
    expect(readFileSync(out, 'utf8')).toContain('a card');
  });

  it('lists the boards when the one asked for is not there', async () => {
    const result = await exportCommand.run(['--db', dbPath, '--board', 'no-such-board']);

    // An operator who does not know the id is exactly the operator who needs
    // this command.
    expect(result.stderr).toContain(BOARD);
  });

  it('says there is no database rather than crashing', async () => {
    const result = await exportCommand.run(['--db', join(dir, 'absent.db')]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('no board database');
  });
});

describe('a database an older build wrote', () => {
  it('is reported as out of date, not as a SQLite error', () => {
    // These commands open without migrating, deliberately: a command that only
    // reports should not rewrite the operator's schema. The cost is a missing
    // column, and a stack trace tells them about better-sqlite3.
    const note = schemaTooOld(new Error('no such column: cards.attempts'));

    expect(note).toContain('older version of Gorilla');
    expect(note).toContain('gorilla serve');
  });

  it('does not swallow an unrelated failure', () => {
    expect(schemaTooOld(new Error('disk I/O error'))).toBeNull();
  });
});

describe('machine-readable output', () => {
  it('carries the markdown rather than replacing it', async () => {
    createCard(handle, { boardId: BOARD, title: 'a card' });

    const result = await exportCommand.run(['--db', dbPath, '--json']);
    const parsed = JSON.parse(result.stdout) as { boardId: string; markdown: string };

    // The markdown is the point of the command. A JSON mode that dropped it
    // would make a script reassemble what the command already rendered.
    expect(parsed.boardId).toBe(BOARD);
    expect(parsed.markdown).toContain('a card');
  });
});
