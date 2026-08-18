import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  conflictedFiles,
  isMerging,
  resolveConflicts,
  resolvePrompt,
} from '../src/server/review/resolve.js';
import { simpleGit } from 'simple-git';

/**
 * Resolving a conflict rather than reporting one.
 *
 * The resolver is a real agent, so nothing here spawns it: `executable` is
 * pointed at a shell that either fixes the files or does not. What is under test
 * is the judgement afterwards, which must come from git and never from what the
 * resolver said about itself.
 */

let dir: string;
let repo: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

/** Leaves `repo` mid-merge with app.txt conflicted, as mergeBranches would. */
function conflictedMerge(): void {
  git(repo, 'checkout', '-q', '-b', 'gorilla/other', 'main');
  writeFileSync(join(repo, 'app.txt'), 'their side\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'their change');

  git(repo, 'checkout', '-q', 'main');
  writeFileSync(join(repo, 'app.txt'), 'our side\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'our change');

  try {
    git(repo, 'merge', '--no-ff', 'gorilla/other');
  } catch {
    // Expected: this is the conflict under test.
  }
}

/**
 * A stand-in resolver: a shell script, so the test exercises the real spawn and
 * the real judgement without a model in the loop.
 */
function fakeResolver(script: string): string {
  const path = join(dir, `resolver-${String(Math.abs(script.length))}.sh`);
  writeFileSync(path, `#!/bin/sh\ncat > /dev/null\n${script}\n`, { mode: 0o755 });
  return path;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gorilla-resolve-'));
  repo = join(dir, 'repo');
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  git(repo, 'config', 'user.email', 't@example.com');
  git(repo, 'config', 'user.name', 'T');
  writeFileSync(join(repo, 'app.txt'), 'original\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'initial');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('reading the repository', () => {
  it('knows when a merge is in progress', () => {
    expect(isMerging(repo)).toBe(false);
    conflictedMerge();
    expect(isMerging(repo)).toBe(true);
  });

  it('lists the conflicted files', async () => {
    conflictedMerge();
    expect(await conflictedFiles(simpleGit(repo))).toEqual(['app.txt']);
  });
});

describe('resolving', () => {
  it('completes the merge when the resolver does its job', async () => {
    conflictedMerge();

    const resolver = fakeResolver(
      `printf 'our side\\ntheir side\\n' > app.txt\n` +
        'git add app.txt\n' +
        'git commit -qm "resolve the conflict"\n',
    );

    const result = await resolveConflicts({
      repoCwd: repo,
      branch: 'gorilla/other',
      into: 'main',
      executable: resolver,
      timeoutMs: 30_000,
    });

    expect(result.outcome).toBe('resolved');
    expect(isMerging(repo)).toBe(false);
    // Both sides kept, which is nearly always the right answer for two agents
    // editing one file in parallel.
    expect(readFileSync(join(repo, 'app.txt'), 'utf8')).toContain('our side');
    expect(readFileSync(join(repo, 'app.txt'), 'utf8')).toContain('their side');
  });

  it('does not believe a resolver that claims success and changed nothing', async () => {
    conflictedMerge();

    // Exits 0, touches nothing. Trusting the exit code would report a resolved
    // conflict that is still sitting in the tree.
    const result = await resolveConflicts({
      repoCwd: repo,
      branch: 'gorilla/other',
      into: 'main',
      executable: fakeResolver('exit 0'),
      timeoutMs: 30_000,
    });

    expect(result.outcome).toBe('still-conflicted');
    expect(result.files).toEqual(['app.txt']);
  });

  it('catches markers removed but the merge never committed', async () => {
    conflictedMerge();

    const result = await resolveConflicts({
      repoCwd: repo,
      branch: 'gorilla/other',
      into: 'main',
      executable: fakeResolver(`printf 'fixed\\n' > app.txt\ngit add app.txt\n`),
      timeoutMs: 30_000,
    });

    // Staged is not merged. Leaving it here would hand the operator a repository
    // that looks resolved and is still mid-merge.
    expect(result.outcome).toBe('still-conflicted');
    expect(result.detail).toContain('never committed');
  });

  it('runs the operator’s verify itself, and reports a failure', async () => {
    conflictedMerge();

    const result = await resolveConflicts({
      repoCwd: repo,
      branch: 'gorilla/other',
      into: 'main',
      verifyCommand: 'test ! -f app.txt',
      executable: fakeResolver(
        `printf 'resolved\\n' > app.txt\ngit add app.txt\ngit commit -qm resolved\n`,
      ),
      timeoutMs: 30_000,
    });

    // The commit stays, so the resolution can be read or reverted.
    expect(result.outcome).toBe('verify-failed');
    expect(result.verify?.status).toBe('failed');
    expect(isMerging(repo)).toBe(false);
  });

  it('refuses when there is no merge to resolve', async () => {
    const result = await resolveConflicts({ repoCwd: repo, branch: 'x', into: 'main' });
    expect(result.outcome).toBe('not-merging');
  });

  it('reports rather than throwing when the repository is gone', async () => {
    const result = await resolveConflicts({
      repoCwd: join(dir, 'absent'),
      branch: 'x',
      into: 'main',
    });
    expect(result.outcome).toBe('errored');
  });

  it('says nothing was resolved when the resolver cannot be run', async () => {
    conflictedMerge();

    const result = await resolveConflicts({
      repoCwd: repo,
      branch: 'gorilla/other',
      into: 'main',
      executable: 'gorilla-no-such-resolver',
      timeoutMs: 30_000,
    });

    expect(result.outcome).toBe('still-conflicted');
    expect(isMerging(repo)).toBe(true);
  });
});

describe('what the resolver is told', () => {
  it('names both branches and every conflicted file', () => {
    const prompt = resolvePrompt({
      branch: 'gorilla/card-a',
      into: 'main',
      files: ['src/one.ts', 'src/two.ts'],
      verifyCommand: 'npm test',
    });

    expect(prompt).toContain('gorilla/card-a');
    expect(prompt).toContain('main');
    expect(prompt).toContain('src/one.ts');
    expect(prompt).toContain('src/two.ts');
    expect(prompt).toContain('npm test');
  });

  it('says to keep both sides rather than picking one', () => {
    const prompt = resolvePrompt({
      branch: 'b',
      into: 'main',
      files: ['a.ts'],
      verifyCommand: null,
    });

    // Two agents editing one file usually both did something wanted; "take
    // ours" would silently discard a card's work.
    expect(prompt).toContain('keep both changes unless they genuinely');
  });

  it('forbids the operations that would destroy the evidence', () => {
    const prompt = resolvePrompt({
      branch: 'b',
      into: 'main',
      files: ['a.ts'],
      verifyCommand: null,
    });

    expect(prompt).toContain('git merge --abort');
    expect(prompt).toContain('Do not change files that are not in the conflicted list');
  });
});
