import { FixtureRecorder } from '../../server/fixtures/recorder.js';
import { startServer } from '../../server/start.js';
import { DEFAULT_HOST, DEFAULT_PORT } from '../../server/index.js';
import type { Command, CommandResult } from '../cli.js';

function parsePort(args: readonly string[]): number {
  const index = args.indexOf('--port');
  if (index === -1) return DEFAULT_PORT;

  const raw = args[index + 1];
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`--port expects a port number, got: ${String(raw)}`);
  }
  return port;
}

export const serveCommand: Command = {
  name: 'serve',
  summary: 'Run the board server and receive hook events',
  async run(args: readonly string[]): Promise<CommandResult> {
    let port: number;
    try {
      port = parsePort(args);
    } catch (error) {
      return { exitCode: 1, stdout: '', stderr: (error as Error).message };
    }

    const recordIndex = args.indexOf('--record');
    let recorder: FixtureRecorder | undefined;
    if (recordIndex !== -1) {
      const target = args[recordIndex + 1];
      if (target === undefined) {
        return { exitCode: 1, stdout: '', stderr: '--record requires a path' };
      }
      // Redaction is the default: a fixture is a file that gets shared, and
      // hook payloads carry source code and shell output (doc 11).
      recorder = new FixtureRecorder({ path: target, redact: !args.includes('--no-redact') });
    }

    const server = await startServer({
      port,
      logger: !args.includes('--quiet'),
      ...(recorder === undefined ? {} : { recorder }),
    });

    // Printed to stderr so it survives --quiet: an operator who cannot find
    // the board has no way to use any of this.
    const board = server.board;
    process.stderr.write(`Gorilla is serving ${server.url}\n`);
    if (board !== null) {
      process.stderr.write(
        `  board "${board.name}" ${board.created ? 'created for' : 'observing'} ${board.cwd}\n`,
      );
    }

    const shutdown = (): void => {
      void server.stop().then(
        () => process.exit(0),
        () => process.exit(1),
      );
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);

    // Resolves only on shutdown; the process stays up serving hooks.
    await new Promise<void>(() => {
      /* intentionally never resolves */
    });

    return { exitCode: 0, stdout: `Listening on http://${DEFAULT_HOST}:${port}`, stderr: '' };
  },
};
