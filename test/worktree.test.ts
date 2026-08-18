import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { addDependency, createCard, moveCard } from '../src/server/api/cards.js';
import { createDefaultColumns } from '../src/server/cards/defaults.js';
import { openDatabase, type DatabaseHandle } from '../src/server/db/client.js';
import { Dispatcher } from '../src/server/dispatch/dispatcher.js';
import { PendingBindings } from '../src/server/binding/pending.js';
import { branchNameFor, WorktreeManager, WORKTREE_DIR } from '../src/server/worktree/manager.js';
import { boards, columns } from '../src/server/db/schema.js';

let dir: string;
let repo: string;
let handle: DatabaseHandle;
let dispatcher: Dispatcher;

const BOARD = 'board-1';

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
}

function fakeClaude(script: string): string {
  const path = join(dir, `fake-${Math.random().toString(36).slice(2)}.sh`);
  writeFileSync(path, `#!/usr/bin/env bash\n${script}\n`, 'utf8');
  chmodSync(path, 0o755);
  return path;
}

function columnNamed(name: string): string {
  const found = handle.db.select().from(columns).where(eq(columns.name, name)).get();
  if (found === undefined) throw new Error(`no column ${name}`);
  return found.id;
}

function card(title: string): string {
  const created = createCard(handle, {
    boardId: BOARD,
    title,
    goalCondition: '`npm test` exits 0',
  });
  moveCard(handle, created.id, columnNamed('Ready'), 0);
  return created.id;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gorilla-worktree-'));
  repo = join(dir, 'repo');

  execFileSync('git', ['init', '-q', repo]);
  execFileSync('git', ['config', 'user.email', 't@example.com'], { cwd: repo });
  execFileSync('git', ['config', 'user.name', 'T'], { cwd: repo });
  writeFileSync(join(repo, 'app.txt'), 'original\n');
  git('add', '.');
  git('commit', '-qm', 'initial');

  handle = openDatabase({ path: join(dir, 'wt.db') });
  handle.db.insert(boards).values({ id: BOARD, name: 'b', cwd: repo, createdAt: 1 }).run();
  createDefaultColumns(handle.db, BOARD);

  dispatcher = new Dispatcher(handle, new PendingBindings());
});

afterEach(async () => {
  await dispatcher.shutdown();
  handle.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('branch names', () => {
  it('slugifies a title and keeps it unique per card', () => {
    const name = branchNameFor('abcdef12-3456', 'Add subtract to calc.py');
    expect(name).toBe('gorilla/add-subtract-to-calc-py-abcdef12');
  });

  it('survives a title that slugifies to nothing', () => {
    expect(branchNameFor('abcdef12-3456', '!!! ???')).toBe('gorilla/abcdef12');
  });

  it('truncates a very long title', () => {
    expect(branchNameFor('abcdef12', 'x'.repeat(200)).length).toBeLessThan(60);
  });
});

describe('WorktreeManager', () => {
  it('creates a worktree on its own branch', async () => {
    const manager = new WorktreeManager(repo);
    const result = await manager.create('card-1', 'First task');

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(existsSync(result.path)).toBe(true);
    expect(result.path).toContain(WORKTREE_DIR);
    expect(git('branch', '--list', result.branch)).toContain(result.branch);
  });

  it('isolates edits from the main checkout', async () => {
    const manager = new WorktreeManager(repo);
    const result = await manager.create('card-1', 'Isolated');
    if (!result.ok) return;

    writeFileSync(join(result.path, 'app.txt'), 'changed by the agent\n');

    // The whole point: one agent's work is invisible to the others until it
    // is merged.
    expect(readFileSync(join(repo, 'app.txt'), 'utf8')).toBe('original\n');
  });

  it('gives two cards separate worktrees that cannot collide', async () => {
    const manager = new WorktreeManager(repo);
    const first = await manager.create('card-1', 'First');
    const second = await manager.create('card-2', 'Second');
    if (!first.ok || !second.ok) return;

    writeFileSync(join(first.path, 'app.txt'), 'first agent\n');
    writeFileSync(join(second.path, 'app.txt'), 'second agent\n');

    expect(readFileSync(join(first.path, 'app.txt'), 'utf8')).toBe('first agent\n');
    expect(readFileSync(join(second.path, 'app.txt'), 'utf8')).toBe('second agent\n');
    expect(first.branch).not.toBe(second.branch);
  });

  it('adopts an existing worktree after a restart', async () => {
    const first = new WorktreeManager(repo);
    const created = await first.create('card-1', 'Survives');
    if (!created.ok) return;
    writeFileSync(join(created.path, 'night-of-work.txt'), 'do not lose me\n');

    // A new manager, as though the board process had restarted.
    const second = new WorktreeManager(repo);
    const adopted = await second.create('card-1', 'Survives');

    expect(adopted.ok).toBe(true);
    if (!adopted.ok) return;
    expect(adopted.created).toBe(false);
    expect(readFileSync(join(adopted.path, 'night-of-work.txt'), 'utf8')).toContain('do not lose');
  });

  it('branches from a base ref when one is given', async () => {
    const manager = new WorktreeManager(repo);
    const first = await manager.create('card-1', 'Base');
    if (!first.ok) return;

    writeFileSync(join(first.path, 'from-first.txt'), 'yes\n');
    execFileSync('git', ['add', '.'], { cwd: first.path });
    execFileSync('git', ['commit', '-qm', 'first work'], { cwd: first.path });

    const second = await manager.create('card-2', 'Dependent', first.branch);
    if (!second.ok) return;

    // Declared work composes: the dependent card can see it.
    expect(existsSync(join(second.path, 'from-first.txt'))).toBe(true);
  });

  it('refuses outside a git repository rather than throwing', async () => {
    const notRepo = join(dir, 'plain');
    execFileSync('mkdir', ['-p', notRepo]);

    const result = await new WorktreeManager(notRepo).create('card-1', 'x');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('not a git repository');
  });

  it('reports uncommitted work, which review has to account for', async () => {
    const manager = new WorktreeManager(repo);
    const created = await manager.create('card-1', 'Dirty');
    if (!created.ok) return;

    writeFileSync(join(created.path, 'app.txt'), 'uncommitted\n');

    const status = await manager.statusOf('card-1');
    expect(status?.dirty).toBeGreaterThan(0);
    expect(status?.branch).toBe(created.branch);
  });
});

describe('removal', () => {
  it('refuses to remove a worktree holding uncommitted work', async () => {
    const manager = new WorktreeManager(repo);
    const created = await manager.create('card-1', 'Has work');
    if (!created.ok) return;

    writeFileSync(join(created.path, 'app.txt'), 'unreviewed\n');

    const removed = await manager.remove('card-1');

    // The operator asked to tidy up, not to discard work they have not seen.
    expect(removed.ok).toBe(false);
    expect(existsSync(created.path)).toBe(true);
  });

  it('removes a clean worktree when asked', async () => {
    const manager = new WorktreeManager(repo);
    const created = await manager.create('card-1', 'Clean');
    if (!created.ok) return;

    expect((await manager.remove('card-1')).ok).toBe(true);
    expect(existsSync(created.path)).toBe(false);
  });

  it('forces removal only when explicitly told to', async () => {
    const manager = new WorktreeManager(repo);
    const created = await manager.create('card-1', 'Forced');
    if (!created.ok) return;
    writeFileSync(join(created.path, 'app.txt'), 'discarded\n');

    expect((await manager.remove('card-1', { force: true })).ok).toBe(true);
    expect(existsSync(created.path)).toBe(false);
  });
});

describe('dispatching into a worktree', () => {
  it('runs the agent in the card worktree, not the board directory', async () => {
    const marker = join(dir, 'cwd.txt');
    dispatcher.useExecutable(
      fakeClaude(`pwd > ${marker}\necho '{"type":"system","session_id":"s"}'`),
    );

    const id = card('works in isolation');
    const running = await dispatcher.dispatchIsolated(BOARD, id);
    await running?.result;

    const where = readFileSync(marker, 'utf8').trim();
    expect(where).toContain(WORKTREE_DIR);
    expect(where).not.toBe(repo);
  });

  it('keeps the worktree after the run, because it is the deliverable', async () => {
    dispatcher.useExecutable(fakeClaude(`echo '{"type":"system","session_id":"s"}'`));

    const id = card('keeps its work');
    await (
      await dispatcher.dispatchIsolated(BOARD, id)
    )?.result;

    await vi.waitFor(() => expect(dispatcher.state(BOARD).halted).not.toBeNull());
    expect(dispatcher.worktreesFor(repo).pathFor(id)).toBeDefined();
    expect(existsSync(dispatcher.worktreesFor(repo).pathFor(id) ?? '')).toBe(true);
  });

  it('halts rather than running several agents in one checkout', async () => {
    const notRepo = join(dir, 'plain-board');
    execFileSync('mkdir', ['-p', notRepo]);
    handle.db.update(boards).set({ cwd: notRepo }).where(eq(boards.id, BOARD)).run();

    dispatcher.useExecutable(fakeClaude(`echo '{"type":"system","session_id":"s"}'`));
    const id = card('cannot be isolated');

    expect(await dispatcher.dispatchIsolated(BOARD, id)).toBeNull();
    expect(dispatcher.state(BOARD).halted?.reason).toBe('no-workspace');
  });

  it('branches a dependent card from its dependency', async () => {
    dispatcher.useExecutable(fakeClaude(`echo '{"type":"system","session_id":"s"}'`));

    const first = card('first');
    const second = card('second');
    addDependency(handle, second, first);

    await (
      await dispatcher.dispatchIsolated(BOARD, first)
    )?.result;
    const firstWorkspace = dispatcher.worktreesFor(repo).workspaceFor(first);

    await dispatcher.dispatchIsolated(BOARD, second);
    const secondWorkspace = dispatcher.worktreesFor(repo).workspaceFor(second);

    // Declared work composes; undeclared work stays isolated.
    expect(secondWorkspace?.baseRef).toBe(firstWorkspace?.branch);
  });
});

describe('rediscovering worktrees after a restart', () => {
  it('finds a worktree that a previous process created', async () => {
    const first = new WorktreeManager(repo);
    const made = await first.create('card-1', 'Some work');
    expect('path' in made).toBe(true);

    // A fresh manager is exactly what a restarted board has: an empty map, and
    // a worktree sitting on disk that git already knows about.
    const afterRestart = new WorktreeManager(repo);
    expect(afterRestart.workspaceFor('card-1')).toBeUndefined();

    expect(await afterRestart.adopt()).toBe(1);
    const found = afterRestart.workspaceFor('card-1');
    expect(found?.branch).toContain('card-1');
    expect(found?.created).toBe(false);
  });

  it('ignores worktrees that are not the board’s', async () => {
    const outside = join(dir, 'unrelated');
    execFileSync('git', ['worktree', 'add', '-q', '-b', 'someone-elses', outside], { cwd: repo });

    const manager = new WorktreeManager(repo);
    expect(await manager.adopt()).toBe(0);
    expect(manager.list()).toHaveLength(0);
  });

  it('does not overwrite what it already knows', async () => {
    const manager = new WorktreeManager(repo);
    await manager.create('card-1', 'Some work');

    // Adoption is a repair for a cold start, not a refresh that could clobber
    // the baseRef a live create recorded.
    expect(await manager.adopt()).toBe(0);
    expect(manager.workspaceFor('card-1')?.created).toBe(true);
  });

  it('is quiet when the board directory is not a repository', async () => {
    const manager = new WorktreeManager(join(dir, 'not-a-repo'));
    expect(await manager.adopt()).toBe(0);
  });
});
