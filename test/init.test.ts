import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { InitError, runInit, settingsPathFor } from '../src/cli/commands/init.js';
import { HOOK_DEFINITIONS, DEFAULT_HOOK_BASE_URL } from '../src/hooks/definitions.js';
import { mergeHookSettings, isUpToDate } from '../src/hooks/settings.js';

const run = promisify(execFile);
const builtCli = fileURLToPath(new URL('../dist/cli/index.js', import.meta.url));

let dir: string;

const base = {
  shared: false,
  dryRun: false,
  force: false,
  baseUrl: DEFAULT_HOOK_BASE_URL,
};

function project(): string {
  mkdirSync(join(dir, '.claude'), { recursive: true });
  return dir;
}

function readSettings(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gorilla-init-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('empty project', () => {
  it('writes every hook definition', () => {
    const cwd = project();
    const outcome = runInit({ ...base, cwd });

    expect(outcome.written).toBe(true);
    expect(outcome.path).toBe(settingsPathFor(cwd, false));
    expect(outcome.added).toHaveLength(HOOK_DEFINITIONS.length);
    expect(outcome.replaced).toHaveLength(0);

    const settings = readSettings(outcome.path) as { hooks: Record<string, unknown[]> };
    for (const definition of HOOK_DEFINITIONS) {
      expect(settings.hooks[definition.event]).toBeDefined();
    }
  });

  it('produces a document matching the documented shape', () => {
    const cwd = project();
    const outcome = runInit({ ...base, cwd });
    const settings = readSettings(outcome.path) as {
      hooks: Record<string, { matcher?: string; hooks: { type: string; url: string }[] }[]>;
    };

    const preCompact = settings.hooks['PreCompact']?.[0];
    expect(preCompact?.hooks[0]).toMatchObject({
      type: 'http',
      url: 'http://127.0.0.1:4300/hooks/PreCompact',
      timeout: 120,
    });

    const postToolUse = settings.hooks['PostToolUse']?.[0];
    expect(postToolUse?.matcher).toBe('Edit|Write|NotebookEdit|Bash');

    // Events without a matcher must not carry the key at all.
    expect(settings.hooks['Stop']?.[0]).not.toHaveProperty('matcher');
  });

  it('binds only to loopback', () => {
    const cwd = project();
    const outcome = runInit({ ...base, cwd });
    expect(outcome.contents).not.toMatch(/0\.0\.0\.0|localhost/);
    expect(outcome.contents).toContain('127.0.0.1');
  });
});

describe('existing unrelated configuration', () => {
  it('preserves foreign hooks and unrelated top-level keys', () => {
    const cwd = project();
    const path = settingsPathFor(cwd, false);
    writeFileSync(
      path,
      JSON.stringify({
        permissions: { allow: ['Bash(git diff *)'] },
        hooks: {
          PostToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: './fmt.sh' }] }],
          PreCompact: [{ hooks: [{ type: 'command', command: './archive.sh' }] }],
        },
      }),
      'utf8',
    );

    const outcome = runInit({ ...base, cwd });
    const settings = readSettings(path) as {
      permissions: unknown;
      hooks: Record<string, { hooks: { type: string; command?: string; url?: string }[] }[]>;
    };

    expect(settings.permissions).toEqual({ allow: ['Bash(git diff *)'] });
    expect(outcome.preserved).toBe(2);

    const postToolUse = settings.hooks['PostToolUse'] ?? [];
    expect(postToolUse).toHaveLength(2);
    expect(postToolUse[0]?.hooks[0]?.command).toBe('./fmt.sh');
    expect(postToolUse[1]?.hooks[0]?.url).toContain('/hooks/PostToolUse');
  });

  it('leaves hook events Gorilla does not subscribe to alone', () => {
    const cwd = project();
    const path = settingsPathFor(cwd, false);
    writeFileSync(
      path,
      JSON.stringify({ hooks: { FileChanged: [{ hooks: [{ type: 'command', command: 'x' }] }] } }),
      'utf8',
    );

    runInit({ ...base, cwd });
    const settings = readSettings(path) as { hooks: Record<string, unknown[]> };
    expect(settings.hooks['FileChanged']).toHaveLength(1);
  });
});

describe('idempotency', () => {
  it('is a no-op on the second run', () => {
    const cwd = project();
    const first = runInit({ ...base, cwd });
    const afterFirst = readFileSync(first.path, 'utf8');

    const second = runInit({ ...base, cwd });

    expect(second.written).toBe(false);
    expect(second.unchanged).toBe(true);
    expect(second.replaced).toHaveLength(HOOK_DEFINITIONS.length);
    expect(second.added).toHaveLength(0);
    expect(readFileSync(second.path, 'utf8')).toBe(afterFirst);
  });

  it('does not accumulate duplicate entries across many runs', () => {
    const cwd = project();
    for (let i = 0; i < 5; i += 1) runInit({ ...base, cwd });

    const settings = readSettings(settingsPathFor(cwd, false)) as {
      hooks: Record<string, unknown[]>;
    };
    for (const definition of HOOK_DEFINITIONS) {
      expect(settings.hooks[definition.event]).toHaveLength(1);
    }
  });

  it('replaces its own entry when the base URL changes', () => {
    const cwd = project();
    runInit({ ...base, cwd });
    runInit({ ...base, cwd, baseUrl: 'http://127.0.0.1:4300' });

    const settings = readSettings(settingsPathFor(cwd, false)) as {
      hooks: Record<string, unknown[]>;
    };
    expect(settings.hooks['Stop']).toHaveLength(1);
  });
});

describe('dry run', () => {
  it('writes nothing', () => {
    const cwd = project();
    const outcome = runInit({ ...base, cwd, dryRun: true });

    expect(outcome.written).toBe(false);
    expect(outcome.dryRun).toBe(true);
    expect(outcome.contents).toContain('PreCompact');
    expect(() => readFileSync(outcome.path, 'utf8')).toThrow();
  });

  it('does not modify an existing file', () => {
    const cwd = project();
    const path = settingsPathFor(cwd, false);
    writeFileSync(path, JSON.stringify({ hooks: {} }), 'utf8');
    const before = readFileSync(path, 'utf8');

    runInit({ ...base, cwd, dryRun: true });
    expect(readFileSync(path, 'utf8')).toBe(before);
  });
});

describe('target selection', () => {
  it('defaults to settings.local.json', () => {
    const cwd = project();
    expect(runInit({ ...base, cwd }).path).toMatch(/settings\.local\.json$/);
  });

  it('targets settings.json with --shared', () => {
    const cwd = project();
    expect(runInit({ ...base, cwd, shared: true }).path).toMatch(/[/\\]settings\.json$/);
  });

  it('never touches the user-level settings file', () => {
    const cwd = project();
    const outcome = runInit({ ...base, cwd });
    expect(outcome.path.startsWith(cwd)).toBe(true);
  });
});

describe('refusal', () => {
  it('refuses a directory that is neither a project nor a repository', () => {
    expect(() => runInit({ ...base, cwd: dir })).toThrow(InitError);
  });

  it('proceeds with --force', () => {
    expect(runInit({ ...base, cwd: dir, force: true }).written).toBe(true);
  });

  it('accepts a git repository without a .claude directory', () => {
    mkdirSync(join(dir, '.git'), { recursive: true });
    expect(runInit({ ...base, cwd: dir }).written).toBe(true);
  });

  it('refuses to merge into malformed JSON rather than overwriting it', () => {
    const cwd = project();
    writeFileSync(settingsPathFor(cwd, false), '{ this is not json', 'utf8');
    expect(() => runInit({ ...base, cwd })).toThrow(/not valid JSON/);
  });

  it('treats an empty file as an empty document', () => {
    const cwd = project();
    writeFileSync(settingsPathFor(cwd, false), '   \n', 'utf8');
    expect(runInit({ ...base, cwd }).written).toBe(true);
  });
});

describe('mergeHookSettings', () => {
  it('does not mutate its input', () => {
    const input = { hooks: { Stop: [] } };
    const snapshot = JSON.stringify(input);
    mergeHookSettings(input);
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  it('reports a merged document as up to date', () => {
    const { settings } = mergeHookSettings({});
    expect(isUpToDate(settings)).toBe(true);
    expect(isUpToDate({})).toBe(false);
  });
});

describe('cli surface', () => {
  it('runs init through the built binary', async () => {
    const cwd = project();
    const { stdout } = await run(process.execPath, [builtCli, 'init', '--dir', cwd, '--dry-run']);
    expect(stdout).toContain('Would write');
    expect(stdout).toContain('PreCompact');
  });

  it('lists init in help', async () => {
    const { stdout } = await run(process.execPath, [builtCli, '--help']);
    expect(stdout).toContain('init');
  });

  it('exits non-zero on an unknown option', async () => {
    await expect(run(process.execPath, [builtCli, 'init', '--nope'])).rejects.toMatchObject({
      code: 1,
    });
  });
});
