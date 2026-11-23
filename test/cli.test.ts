import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { VERSION, commandHelpText, helpText, registeredCommands, runCli } from '../src/cli/cli.js';
import { registerBuiltinCommands } from '../src/cli/register.js';
import { serveCommand } from '../src/cli/commands/serve.js';
import { startServer } from '../src/server/start.js';
import { DEFAULT_HOST, DEFAULT_PORT } from '../src/server/index.js';

/** Out of the way of the default and of every other test's port. */
const BUSY_PORT = 4471;

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

/**
 * `gorilla <command> --help` answers before the command runs (case study 1:
 * `serve --help` opened the real database, created a board and bound a port).
 */
describe('per-command help', () => {
  registerBuiltinCommands();

  it.each(registeredCommands().map((command) => command.name))(
    '%s --help prints its usage and exits 0',
    async (name) => {
      for (const flag of ['--help', '-h']) {
        const result = await runCli([name, flag]);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain(`gorilla ${name}`);
      }
    },
  );

  it('serve --help names its options', () => {
    expect(commandHelpText(serveCommand)).toContain('--port');
  });

  it('serve --help from the built binary neither opens a database nor serves', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gorilla-help-'));
    const dbPath = join(dir, 'never.db');
    try {
      // A server would never exit; the timeout turns that into a failure.
      const { stdout } = await run(process.execPath, [builtCli, 'serve', '--help'], {
        cwd: dir,
        env: { ...process.env, GORILLA_DB_PATH: dbPath },
        timeout: 10_000,
      });
      expect(stdout).toContain('gorilla serve');
      expect(existsSync(dbPath)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('server defaults', () => {
  it('binds to loopback only', () => {
    expect(DEFAULT_HOST).toBe('127.0.0.1');
    expect(DEFAULT_PORT).toBe(4300);
  });
});

/**
 * Starting the board when it is already started.
 *
 * The obvious thing to do when you cannot remember whether it is running, and
 * until this it answered with a Node stack trace ending in EADDRINUSE. An easy
 * command is only easy if its commonest failure is legible.
 */
describe('serving on a port that is taken', () => {
  // `serve` has no database option, so these name one through the
  // environment. Without it they wrote boards into the operator's real
  // database (case study 1); the shared setup also sets one, but a test that
  // depends on it silently is how that happened the first time.
  let previousDb: string | undefined;
  let dbDir: string;
  beforeEach(() => {
    previousDb = process.env['GORILLA_DB_PATH'];
    dbDir = mkdtempSync(join(tmpdir(), 'gorilla-busy-db-'));
    process.env['GORILLA_DB_PATH'] = join(dbDir, 'serve.db');
  });
  afterEach(() => {
    if (previousDb === undefined) delete process.env['GORILLA_DB_PATH'];
    else process.env['GORILLA_DB_PATH'] = previousDb;
    rmSync(dbDir, { recursive: true, force: true });
  });

  it('says a board is already there, when one is', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gorilla-serve-'));
    const server = await startServer({
      port: BUSY_PORT,
      dbPath: join(dir, 'a.db'),
      cwd: dir,
      logger: false,
    });

    try {
      const result = await serveCommand.run(['--port', String(BUSY_PORT), '--quiet']);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('already serving');
      expect(result.stderr).toContain(String(BUSY_PORT));
    } finally {
      await server.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('says what to do instead, when the port holds something else', async () => {
    const other = createServer((_, response) => response.end('not a board'));
    await new Promise<void>((resolve) => other.listen(BUSY_PORT + 1, DEFAULT_HOST, resolve));

    try {
      const result = await serveCommand.run(['--port', String(BUSY_PORT + 1), '--quiet']);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('not a Gorilla board');
      // Names the next port rather than leaving the operator to pick one.
      expect(result.stderr).toContain(`--port ${String(BUSY_PORT + 2)}`);
    } finally {
      await new Promise<void>((resolve) => other.close(() => resolve()));
    }
  });
});

describe('built binary', () => {
  it('prints usage when invoked as a built executable', async () => {
    const { stdout } = await run(process.execPath, [builtCli, '--help']);
    expect(stdout).toContain('Usage: gorilla');
  });
});
