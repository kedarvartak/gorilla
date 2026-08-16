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

    const server = await startServer({ port, logger: !args.includes('--quiet') });

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
