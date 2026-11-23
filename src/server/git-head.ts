import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

/**
 * The commit a checkout is on, or null when there is no answer.
 *
 * Synchronous on purpose: it is read once when a run starts and once when it
 * ends, both single indexed updates on paths that are already synchronous, and
 * `git rev-parse` answers in milliseconds. Never throws - a run in a directory
 * that is not a repository simply has no recorded commit.
 */
export function gitHeadSync(cwd: string): string | null {
  if (cwd === '' || !existsSync(cwd)) return null;
  try {
    const sha = execFileSync('git', ['rev-parse', '--verify', '--quiet', 'HEAD'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5_000,
    }).trim();
    return /^[0-9a-f]{7,64}$/.test(sha) ? sha : null;
  } catch {
    return null;
  }
}
