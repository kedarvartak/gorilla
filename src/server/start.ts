import type { FastifyInstance } from 'fastify';

import { randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';

import { buildApp } from './app.js';
import { createDefaultColumns } from './cards/defaults.js';
import { canonicaliseCwd } from './ingest/binding.js';
import { boards } from './db/schema.js';
import type { FixtureRecorder } from './fixtures/recorder.js';
import { openDatabase, type DatabaseHandle } from './db/client.js';
import { DEFAULT_HOST, DEFAULT_PORT } from './index.js';
import type { ExtractionModel } from './ledger/model.js';
import { describeReconcile, reconcileOpenRuns } from './ingest/lifecycle.js';

export interface EnsuredBoard {
  readonly id: string;
  readonly name: string;
  readonly cwd: string;
  readonly created: boolean;
}

/**
 * A board for the directory the server was started in.
 *
 * Without this the first thing an operator must do is POST JSON to create a
 * board, which is a poor answer to "how do I use this" and contradicts P9. A
 * board is bound to a directory anyway, and `serve` is run from the project, so
 * the directory is not a guess.
 */
export function ensureBoardForCwd(database: DatabaseHandle, cwd: string): EnsuredBoard {
  const canonical = canonicaliseCwd(cwd);

  const existing = database.db.select().from(boards).where(eq(boards.cwd, canonical)).get();
  if (existing !== undefined) {
    return { id: existing.id, name: existing.name, cwd: existing.cwd, created: false };
  }

  const id = randomUUID();
  const name = canonical.split(/[/\\]/).filter(Boolean).pop() ?? canonical;

  database.db.insert(boards).values({ id, name, cwd: canonical, createdAt: Date.now() }).run();
  createDefaultColumns(database.db, id);

  return { id, name, cwd: canonical, created: true };
}

export interface StartOptions {
  readonly port?: number;
  readonly host?: string;
  readonly dbPath?: string;
  readonly logger?: boolean;
  readonly recorder?: FixtureRecorder;
  /** Defaults to true. Tests that assert on an empty board turn it off. */
  readonly ensureBoard?: boolean;
  readonly cwd?: string;
  /**
   * The extraction model. Left absent by tests and supplied by `serve` from the
   * environment, so no test can spend money on a key the shell exported.
   */
  readonly extractionModel?: ExtractionModel;
}

export interface RunningServer {
  readonly app: FastifyInstance;
  readonly database: DatabaseHandle;
  readonly url: string;
  readonly board: EnsuredBoard | null;
  /** What startup found left open, so `serve` can say so rather than hide it. */
  readonly reconciled: string | null;
  stop(): Promise<void>;
}

export async function startServer(options: StartOptions = {}): Promise<RunningServer> {
  const port = options.port ?? DEFAULT_PORT;
  // Loopback only. Transcripts and tool payloads contain source code, so this
  // must never be reachable from the network (doc 11).
  const host = options.host ?? DEFAULT_HOST;

  const database = openDatabase(options.dbPath === undefined ? {} : { path: options.dbPath });

  const board =
    options.ensureBoard === false
      ? null
      : ensureBoardForCwd(database, options.cwd ?? process.cwd());
  // Before serving: the board has just started, so it cannot be supervising
  // anything, and a run still marked open is one that was cut off.
  const reconciled = describeReconcile(reconcileOpenRuns(database.sqlite));

  const app = buildApp({
    database,
    logger: options.logger ?? true,
    ...(options.recorder === undefined ? {} : { recorder: options.recorder }),
    ...(options.extractionModel === undefined ? {} : { extractionModel: options.extractionModel }),
  });

  await app.listen({ port, host });

  return {
    app,
    database,
    board,
    reconciled,
    url: `http://${host}:${port}`,
    stop: async () => {
      await app.close();
      database.close();
    },
  };
}
