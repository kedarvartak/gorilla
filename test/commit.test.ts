import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { boardCommitMessage, commitWorkspace } from '../src/server/worktree/commit.js';
import { renderCardContext } from '../src/server/launcher/args.js';
import { EMPTY_GUARDRAILS } from '../src/server/cards/guardrails.js';

/**
 * Committing a finished card's work.
 *
 * Written after the same failure twice: the work existed, the tests passed, and
 * the branch was empty, because nothing had told the agent it was on a branch.
 */

let dir: string;
let repo: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gorilla-commit-'));
  repo = join(dir, 'repo');
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  git(repo, 'config', 'user.email', 't@example.com');
  git(repo, 'config', 'user.name', 'T');
  writeFileSync(join(repo, 'seed.txt'), 'seed\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'initial');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('committing what a run left behind', () => {
  it('puts uncommitted work on the branch', async () => {
    writeFileSync(join(repo, 'new.ts'), 'export const work = 1;\n');

    const result = await commitWorkspace({ cwd: repo, cardId: 'card-1', cardTitle: 'Some work' });

    expect(result.committed).toBe(true);
    expect(result.files).toBe(1);
    expect(git(repo, 'status', '--porcelain').trim()).toBe('');
  });

  it('does nothing when the agent already committed as it went', async () => {
    // The good case. The board's commit is a floor, not a replacement: an agent
    // that commits itself writes better messages than this can.
    const result = await commitWorkspace({ cwd: repo, cardId: 'card-1', cardTitle: 'Tidy' });

    expect(result.committed).toBe(false);
    expect(result.reason).toBe('nothing left uncommitted');
  });

  it('respects gitignore, so build output stays off the branch', async () => {
    writeFileSync(join(repo, '.gitignore'), 'dist/\n');
    git(repo, 'add', '.gitignore');
    git(repo, 'commit', '-qm', 'ignore dist');
    mkdirSync(join(repo, 'dist'));
    writeFileSync(join(repo, 'dist', 'bundle.js'), 'noise\n');
    writeFileSync(join(repo, 'real.ts'), 'export const real = 1;\n');

    await commitWorkspace({ cwd: repo, cardId: 'card-1', cardTitle: 'Work' });

    expect(git(repo, 'ls-files').split('\n')).toContain('real.ts');
    expect(git(repo, 'ls-files')).not.toContain('dist/bundle.js');
  });

  it('reports rather than throws when the worktree is gone', async () => {
    // Never throws into the settle path: a failed commit costs a merge that can
    // still be done by hand, a thrown error costs the card its outcome.
    const result = await commitWorkspace({
      cwd: join(dir, 'absent'),
      cardId: 'card-1',
      cardTitle: 'Gone',
    });

    expect(result.committed).toBe(false);
    expect(result.reason).toContain('no longer exists');
  });

  it('says who made the commit and why', () => {
    const message = boardCommitMessage('Some work', 'card-1');

    expect(message.split('\n')[0]).toBe('Some work');
    expect(message).toContain('Committed by the board');
    expect(message).toContain('would not be merged');
    expect(message).toContain('card-1');
  });
});

describe('telling the agent it has a branch', () => {
  it('names the branch and says to commit to it', () => {
    const context = renderCardContext({
      title: 'A card',
      body: 'Do the thing.',
      guardrails: EMPTY_GUARDRAILS,
      branch: 'gorilla/a-card-abc123',
    });

    expect(context).toContain('gorilla/a-card-abc123');
    expect(context).toContain('Commit your work before you finish');
    // The specific thing an agent cannot infer: the directory is a throwaway
    // whose contents reach nobody until they are committed.
    expect(context).toContain('reaches anyone until it is committed');
  });

  it('warns it off the operations the board owns', () => {
    const context = renderCardContext({
      title: 'A card',
      body: '',
      guardrails: EMPTY_GUARDRAILS,
      branch: 'gorilla/a-card',
    });

    expect(context).toContain('Do not merge, rebase, push, or switch branches');
  });

  it('says nothing about branches for a card without a worktree', () => {
    const context = renderCardContext({
      title: 'A card',
      body: '',
      guardrails: EMPTY_GUARDRAILS,
    });

    expect(context).not.toContain('Your branch');
  });
});
