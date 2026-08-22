import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDatabase, type DatabaseHandle } from '../src/server/db/client.js';
import { BindingResolver, owningBoardCwd } from '../src/server/ingest/binding.js';
import { ensureBoardForCwd } from '../src/server/start.js';
import { WORKTREE_DIR } from '../src/server/worktree/manager.js';

/**
 * A worktree is not a board (T67).
 *
 * A dispatched card runs in `<board>/.gorilla/worktrees/<cardId>` and reports
 * that path as its cwd. Taken literally, every card the board ever dispatched
 * becomes a board of its own, named after a uuid, holding the runs that
 * belonged to the project.
 *
 * Found by running `gorilla status` against the real database and seeing five
 * boards where there is one project.
 */

let dir: string;
let handle: DatabaseHandle;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gorilla-wt-board-'));
  mkdirSync(join(dir, WORKTREE_DIR, 'card-1'), { recursive: true });
  handle = openDatabase({ path: join(dir, 'b.db') });
});

afterEach(() => {
  handle.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('resolving a worktree to its project', () => {
  it('strips the worktree suffix', () => {
    expect(owningBoardCwd(join(dir, WORKTREE_DIR, 'card-1'))).toBe(owningBoardCwd(dir));
  });

  it('leaves an ordinary directory alone', () => {
    expect(owningBoardCwd(dir)).toBe(owningBoardCwd(dir));
    expect(owningBoardCwd(join(dir, 'src'))).toContain('src');
  });

  it('does not mistake a project that merely contains the words', () => {
    // The marker is a path this system wrote itself, not a guess about names.
    const decoy = join(dir, 'gorilla-worktrees-notes');
    expect(owningBoardCwd(decoy)).toBe(decoy);
  });
});

describe('what the hook path does with a card’s session', () => {
  it('attributes the run to the project, not to the worktree', () => {
    const resolver = new BindingResolver(handle.sqlite);

    const project = resolver.boardForCwd(dir);
    const fromWorktree = resolver.boardForCwd(join(dir, WORKTREE_DIR, 'card-1'));

    expect(fromWorktree).toBe(project);
  });

  it('creates exactly one board for a project and all its cards', () => {
    const resolver = new BindingResolver(handle.sqlite);

    resolver.boardForCwd(join(dir, WORKTREE_DIR, 'card-1'));
    mkdirSync(join(dir, WORKTREE_DIR, 'card-2'), { recursive: true });
    resolver.boardForCwd(join(dir, WORKTREE_DIR, 'card-2'));
    resolver.boardForCwd(dir);

    const boards = handle.sqlite.prepare('SELECT id FROM boards').all();
    expect(boards).toHaveLength(1);
  });
});

describe('serving from inside a worktree', () => {
  it('finds the project’s board rather than making a second one', () => {
    const project = ensureBoardForCwd(handle, dir);
    const again = ensureBoardForCwd(handle, join(dir, WORKTREE_DIR, 'card-1'));

    expect(again.id).toBe(project.id);
    expect(again.created).toBe(false);
  });
});
