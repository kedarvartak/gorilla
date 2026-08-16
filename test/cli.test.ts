import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { VERSION, helpText, runCli } from '../src/cli/cli.js';
import { DEFAULT_HOST, DEFAULT_PORT } from '../src/server/index.js';

const run = promisify(execFile);
const builtCli = fileURLToPath(new URL('../dist/cli/index.js', import.meta.url));

describe('runCli', () => {
  it('prints usage with no arguments', async () => {
    const result = await runCli([]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Usage: gorilla');
  });

  it.each(['-h', '--help', 'help'])('prints usage for %s', async (flag) => {
    const result = await runCli([flag]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(helpText());
  });

  it.each(['-v', '--version', 'version'])('prints the version for %s', async (flag) => {
    const result = await runCli([flag]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(VERSION);
  });

  it('fails with a non-zero exit code on an unknown command', async () => {
    const result = await runCli(['nope']);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('Unknown command: nope');
  });
});

describe('server defaults', () => {
  it('binds to loopback only', () => {
    expect(DEFAULT_HOST).toBe('127.0.0.1');
    expect(DEFAULT_PORT).toBe(4300);
  });
});

describe('built binary', () => {
  it('prints usage when invoked as a built executable', async () => {
    const { stdout } = await run(process.execPath, [builtCli, '--help']);
    expect(stdout).toContain('Usage: gorilla');
  });
});
