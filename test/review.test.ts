import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { describeMergeReport, mergeBranches } from '../src/server/review/merge.js';

let dir: string;
let repo: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

/** A branch that changes `file` to `content`, as an agent's worktree would. */
function branchWith(name: string, file: string, content: string): void {
  git(repo, 'checkout', '-q', '-b', name, 'main');
  writeFileSync(join(repo, file), content);
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', `work on ${name}`);
  git(repo, 'checkout', '-q', 'main');
}

const card = (name: string, branch: string) => ({ cardId: name, title: name, branch });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gorilla-review-'));
  repo = join(dir, 'repo');

  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  git(repo, 'config', 'user.email', 't@example.com');
  git(repo, 'config', 'user.name', 'T');
  writeFileSync(join(repo, 'app.txt'), 'original\n');
  writeFileSync(join(repo, 'other.txt'), 'other\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'initial');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('merging a night of work', () => {
  it('merges several branches in order', async () => {
    branchWith('gorilla/one', 'one.txt', 'first\n');
    branchWith('gorilla/two', 'two.txt', 'second\n');

    const report = await mergeBranches({
      repoCwd: repo,
      cards: [card('one', 'gorilla/one'), card('two', 'gorilla/two')],
      into: 'main',
    });

    expect(report.clean).toBe(true);
    expect(report.merged).toBe(2);
    expect(readFileSync(join(repo, 'one.txt'), 'utf8')).toBe('first\n');
    expect(readFileSync(join(repo, 'two.txt'), 'utf8')).toBe('second\n');
  });

  it('runs the verify command after each merge', async () => {
    branchWith('gorilla/one', 'one.txt', 'first\n');

    const report = await mergeBranches({
      repoCwd: repo,
      cards: [card('one', 'gorilla/one')],
      into: 'main',
      verifyCommand: 'test -f one.txt',
    });

    expect(report.steps[0]?.outcome).toBe('merged');
    expect(report.steps[0]?.verify?.status).toBe('passed');
  });

  it('names the card that broke the project', async () => {
    branchWith('gorilla/good', 'good.txt', 'fine\n');
    branchWith('gorilla/bad', 'broken.txt', 'breaks the build\n');

    const report = await mergeBranches({
      repoCwd: repo,
      cards: [card('good', 'gorilla/good'), card('bad', 'gorilla/bad')],
      into: 'main',
      // Passes until broken.txt exists.
      verifyCommand: 'test ! -f broken.txt',
    });

    expect(report.clean).toBe(false);
    expect(report.merged).toBe(1);
    // Merging one at a time is what buys this: a single named culprit.
    expect(report.stoppedAt?.cardId).toBe('bad');
    expect(report.stoppedAt?.outcome).toBe('verify-failed');
    expect(report.stoppedAt?.detail).toContain('This card broke it');
  });

  it('stops at the first failure and skips the rest', async () => {
    branchWith('gorilla/bad', 'broken.txt', 'x\n');
    branchWith('gorilla/later', 'later.txt', 'y\n');

    const report = await mergeBranches({
      repoCwd: repo,
      cards: [card('bad', 'gorilla/bad'), card('later', 'gorilla/later')],
      into: 'main',
      verifyCommand: 'test ! -f broken.txt',
    });

    // Continuing would leave a broken branch with several candidate causes.
    expect(report.steps[1]?.outcome).toBe('skipped');
    expect(report.steps[1]?.detail).toContain('an earlier card stopped');
  });

  it('reports a conflict and leaves it in place for inspection', async () => {
    branchWith('gorilla/left', 'app.txt', 'left wins\n');
    branchWith('gorilla/right', 'app.txt', 'right wins\n');

    const report = await mergeBranches({
      repoCwd: repo,
      cards: [card('left', 'gorilla/left'), card('right', 'gorilla/right')],
      into: 'main',
    });

    expect(report.merged).toBe(1);
    expect(report.stoppedAt?.outcome).toBe('conflicted');

    // Not aborted: the operator's next question is what clashed, and
    // `git merge --abort` destroys the evidence.
    expect(readFileSync(join(repo, 'app.txt'), 'utf8')).toContain('<<<<<<<');
  });

  it('merges without a verify command when none is given', async () => {
    branchWith('gorilla/one', 'one.txt', 'first\n');

    const report = await mergeBranches({
      repoCwd: repo,
      cards: [card('one', 'gorilla/one')],
      into: 'main',
    });

    expect(report.clean).toBe(true);
    expect(report.steps[0]?.verify).toBeUndefined();
  });

  it('errors rather than throwing on an unknown target branch', async () => {
    const report = await mergeBranches({
      repoCwd: repo,
      cards: [card('one', 'gorilla/one')],
      into: 'does-not-exist',
    });

    expect(report.clean).toBe(false);
    expect(report.stoppedAt?.outcome).toBe('errored');
  });

  it('errors rather than throwing when the repository is gone', async () => {
    const report = await mergeBranches({
      repoCwd: join(dir, 'absent'),
      cards: [card('one', 'gorilla/one')],
    });

    expect(report.merged).toBe(0);
    expect(report.clean).toBe(false);
  });

  it('does not push', async () => {
    branchWith('gorilla/one', 'one.txt', 'first\n');
    // No remote configured; a push would throw and fail the merge.
    const report = await mergeBranches({
      repoCwd: repo,
      cards: [card('one', 'gorilla/one')],
      into: 'main',
    });

    expect(report.clean).toBe(true);
    expect(() => git(repo, 'remote', 'get-url', 'origin')).toThrow();
  });
});

describe('the report', () => {
  it('reads as an answer to "did anything break"', async () => {
    branchWith('gorilla/good', 'good.txt', 'fine\n');
    branchWith('gorilla/bad', 'broken.txt', 'x\n');

    const report = await mergeBranches({
      repoCwd: repo,
      cards: [card('good', 'gorilla/good'), card('bad', 'gorilla/bad')],
      into: 'main',
      verifyCommand: 'test ! -f broken.txt',
    });

    const text = describeMergeReport(report).join('\n');

    expect(text).toContain('1 of 2 merged');
    expect(text).toContain('Stopped at "bad"');
    expect(text).toContain('working tree is left as it is');
  });
});
