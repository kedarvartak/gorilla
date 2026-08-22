import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { describeDiff, diffSummary, fileDiff, UNREADABLE } from '../src/server/worktree/diff.js';

/**
 * What a card's branch actually changed (T30, T31).
 *
 * Reviewing a card meant leaving the board for a terminal, which is the point
 * at which the operator loses the context the board exists to hold.
 */

let dir: string;
let repo: string;

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gorilla-diff-'));
  repo = join(dir, 'repo');

  execFileSync('git', ['init', '-q', repo]);
  execFileSync('git', ['config', 'user.email', 't@example.com'], { cwd: repo });
  execFileSync('git', ['config', 'user.name', 'T'], { cwd: repo });
  writeFileSync(join(repo, 'app.txt'), 'one\ntwo\n');
  git('add', '.');
  git('commit', '-qm', 'initial');

  git('checkout', '-qb', 'work');
  writeFileSync(join(repo, 'app.txt'), 'one\ntwo\nthree\n');
  writeFileSync(join(repo, 'added.txt'), 'new\n');
  git('add', '.');
  git('commit', '-qm', 'the card’s work');
  git('checkout', '-q', 'master');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('summarising a branch', () => {
  it('counts the files and the lines', async () => {
    const summary = await diffSummary(repo, 'work');

    expect(summary.readable).toBe(true);
    expect(summary.files.map((file) => file.path).sort()).toEqual(['added.txt', 'app.txt']);
    expect(summary.insertions).toBe(2);
  });

  it('reports only the card’s own work', async () => {
    // A commit lands on the target after the card branched.
    writeFileSync(join(repo, 'unrelated.txt'), 'elsewhere\n');
    git('add', '.');
    git('commit', '-qm', 'someone else');

    // Three dots, against the merge base. Two would sweep this in and tell the
    // operator the card changed a file it never saw.
    const summary = await diffSummary(repo, 'work');
    expect(summary.files.map((file) => file.path)).not.toContain('unrelated.txt');
  });

  it('says a branch could not be read rather than that it changed nothing', async () => {
    const summary = await diffSummary(repo, 'no-such-branch');

    // A merged card's branch is usually gone. Reporting that as 'changed
    // nothing' would rewrite its history.
    expect(summary).toEqual(UNREADABLE);
    expect(describeDiff(summary)).toContain('could not be read');
  });

  it('distinguishes an empty branch from an unreadable one', async () => {
    git('checkout', '-qb', 'empty');
    git('checkout', '-q', 'master');

    const summary = await diffSummary(repo, 'empty');
    expect(summary.readable).toBe(true);
    expect(describeDiff(summary)).toBe('The branch changes nothing.');
  });

  it('says nothing when there is no branch at all', async () => {
    expect(await diffSummary(repo, null)).toEqual(UNREADABLE);
  });
});

describe('one file’s diff', () => {
  it('returns the patch', async () => {
    const patch = await fileDiff(repo, 'work', 'app.txt');

    expect(patch).toContain('+three');
    expect(patch).not.toContain('added.txt');
  });

  it('returns null for a branch that is gone', async () => {
    expect(await fileDiff(repo, 'no-such-branch', 'app.txt')).toBeNull();
  });

  it('cannot be talked into reading a flag as an option', async () => {
    // The path goes after `--`, so a filename that looks like a flag stays a
    // filename. Nothing here is attacker-supplied today, but the parameter
    // reaches git and the guard costs one array element.
    const patch = await fileDiff(repo, 'work', '--output=/tmp/gorilla-diff-escape');

    expect(patch).toBe('');
  });
});
