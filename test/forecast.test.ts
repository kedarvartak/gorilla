import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { forecastMerge, UNKNOWN } from '../src/server/review/forecast.js';

/**
 * Whether a merge would conflict, asked before committing to it (T39).
 *
 * Finding out by attempting the merge leaves a half-merged working tree behind
 * when the answer is no, which is a heavy price for a question.
 */

let dir: string;
let repo: string;

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gorilla-forecast-'));
  repo = join(dir, 'repo');

  execFileSync('git', ['init', '-q', repo]);
  execFileSync('git', ['config', 'user.email', 't@example.com'], { cwd: repo });
  execFileSync('git', ['config', 'user.name', 'T'], { cwd: repo });
  writeFileSync(join(repo, 'app.txt'), 'one\ntwo\n');
  writeFileSync(join(repo, 'other.txt'), 'untouched\n');
  git('add', '.');
  git('commit', '-qm', 'initial');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('forecasting a merge', () => {
  it('says a clean branch is clean', async () => {
    git('checkout', '-qb', 'work');
    writeFileSync(join(repo, 'other.txt'), 'changed elsewhere\n');
    git('commit', '-qam', 'work');
    git('checkout', '-q', 'master');

    const forecast = await forecastMerge(repo, 'master', 'work');

    expect(forecast.readable).toBe(true);
    expect(forecast.clean).toBe(true);
  });

  it('names the files that would conflict', async () => {
    git('checkout', '-qb', 'work');
    writeFileSync(join(repo, 'app.txt'), 'one\nfrom the card\n');
    git('commit', '-qam', 'the card');
    git('checkout', '-q', 'master');
    writeFileSync(join(repo, 'app.txt'), 'one\nfrom main\n');
    git('commit', '-qam', 'someone else');

    const forecast = await forecastMerge(repo, 'master', 'work');

    expect(forecast.clean).toBe(false);
    expect(forecast.conflicts).toEqual(['app.txt']);
    expect(forecast.note).toContain('app.txt');
  });

  it('leaves the working tree exactly as it found it', async () => {
    git('checkout', '-qb', 'work');
    writeFileSync(join(repo, 'app.txt'), 'one\nfrom the card\n');
    git('commit', '-qam', 'the card');
    git('checkout', '-q', 'master');
    writeFileSync(join(repo, 'app.txt'), 'one\nfrom main\n');
    git('commit', '-qam', 'someone else');

    await forecastMerge(repo, 'master', 'work');

    // The whole point: asking must not cost anything. A half-merged tree is a
    // heavy price for a question, and the operator did not ask to merge.
    expect(git('status', '--porcelain')).toBe('');
    expect(git('rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('master');
  });

  it('does not call an unaskable question clean', async () => {
    // A missing branch produces no answer. Reporting it as clean would send
    // the operator into a merge on the strength of a check that never ran.
    const forecast = await forecastMerge(repo, 'master', 'no-such-branch');

    expect(forecast).toEqual(UNKNOWN);
    expect(forecast.clean).toBe(false);
  });

  it('says nothing when there is no branch to ask about', async () => {
    expect(await forecastMerge(repo, 'master', null)).toEqual(UNKNOWN);
    expect(await forecastMerge(repo, null, 'work')).toEqual(UNKNOWN);
  });
});
