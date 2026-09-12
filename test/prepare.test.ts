import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { describePrepare, prepareWorkspace } from '../src/server/worktree/prepare.js';

/**
 * Preparing a worktree before the agent is let into it.
 *
 * A fresh worktree has the repository and nothing it needs to run. The claim
 * under test is that the board installs what the project says it needs, and
 * that a failure stops the dispatch with the cause named rather than handing
 * an agent a tree that cannot build.
 */

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gorilla-prepare-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('preparing a workspace', () => {
  it('is skipped, not failed, when the project sets no setup command', async () => {
    const result = await prepareWorkspace({ command: null, cwd: dir });

    expect(result.ok).toBe(true);
    expect(result.status).toBe('skipped');
    expect(describePrepare(result, dir)).toBe('No setup command set for this project.');
  });

  it('runs the command in the worktree', async () => {
    const result = await prepareWorkspace({ command: 'pwd > prepared.txt', cwd: dir });

    expect(result.ok).toBe(true);
    expect(result.status).toBe('passed');
    expect(describePrepare(result, dir)).toContain('Workspace prepared with');
  });

  it('carries the output of a failure, so the cause is not something to go digging for', async () => {
    const result = await prepareWorkspace({
      command: 'echo "npm ERR! missing script: bootstrap" >&2; exit 1',
      cwd: dir,
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe('failed');

    const described = describePrepare(result, dir);
    expect(described).toContain('Setup failed');
    expect(described).toContain('missing script: bootstrap');
    expect(described).toContain(dir);
  });

  it('separates a command that could not run from one that ran and failed', async () => {
    const result = await prepareWorkspace({ command: 'definitely-not-a-binary', cwd: dir });

    expect(result.ok).toBe(false);
    expect(describePrepare(result, dir)).toContain('could not run');
  });

  it('reports a missing worktree rather than throwing into the dispatcher', async () => {
    const result = await prepareWorkspace({ command: 'true', cwd: join(dir, 'gone') });

    expect(result.ok).toBe(false);
    expect(result.status).toBe('errored');
  });
});
