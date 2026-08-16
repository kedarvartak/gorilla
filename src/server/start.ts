import type { FastifyInstance } from 'fastify';

import { buildApp } from './app.js';
import type { FixtureRecorder } from './fixtures/recorder.js';
import { openDatabase, type DatabaseHandle } from './db/client.js';
import { DEFAULT_HOST, DEFAULT_PORT } from './index.js';

export interface StartOptions {
  readonly port?: number;
  readonly host?: string;
  readonly dbPath?: string;
  readonly logger?: boolean;
  readonly recorder?: FixtureRecorder;
}

export interface RunningServer {
  readonly app: FastifyInstance;
  readonly database: DatabaseHandle;
  readonly url: string;
  stop(): Promise<void>;
}

export async function startServer(options: StartOptions = {}): Promise<RunningServer> {
  const port = options.port ?? DEFAULT_PORT;
  // Loopback only. Transcripts and tool payloads contain source code, so this
  // must never be reachable from the network (doc 11).
  const host = options.host ?? DEFAULT_HOST;

  const database = openDatabase(options.dbPath === undefined ? {} : { path: options.dbPath });
  const app = buildApp({
    database,
    logger: options.logger ?? true,
    ...(options.recorder === undefined ? {} : { recorder: options.recorder }),
  });

  await app.listen({ port, host });

  return {
    app,
    database,
    url: `http://${host}:${port}`,
    stop: async () => {
      await app.close();
      database.close();
    },
  };
}
