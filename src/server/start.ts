import type { FastifyInstance } from 'fastify';

import { randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';

import { buildApp, contextOf } from './app.js';
import { createDefaultColumns } from './cards/defaults.js';
import { owningBoardCwd } from './ingest/binding.js';
import { boards } from './db/schema.js';
import type { FixtureRecorder } from './fixtures/recorder.js';
import { openDatabase, type DatabaseHandle } from './db/client.js';
import { DEFAULT_HOST, DEFAULT_PORT } from './index.js';
import type { ExtractionModel } from './ledger/model.js';
import { describeReconcile, reconcileOpenRuns } from './ingest/lifecycle.js';
import { describeCardReconcile, reconcileRunningCards } from './cards/reconcile.js';
import { readBuildStamp } from './web/stamp.js';

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
  // Serving from inside a card's worktree resolves to the project, rather than
  // creating a second board for a directory this system made itself (T67).
  const canonical = owningBoardCwd(cwd);

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
  /** Cards that were mid-run when the board last stopped. */
  readonly reconciledCards: string | null;
  /** Set when the served interface is older than the server serving it. */
  readonly staleBuild: string | null;
  /** Worktrees rediscovered on disk. */
  readonly adopted: number;
  stop(): Promise<void>;
}

/** Repopulates each board's worktree map from what git reports on disk. */
async function adoptWorktrees(app: FastifyInstance, database: DatabaseHandle): Promise<number> {
  const context = contextOf(app);
  if (context === undefined) return 0;

  let total = 0;
  for (const board of database.db.select().from(boards).all()) {
    total += await context.dispatcher.worktreesFor(board.cwd).adopt();
  }
  return total;
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
  // The card's side of the same fact. Dispatch is in-process, so a card found
  // in `running` has nothing supervising it and nothing that ever will.
  const reconciledCards = describeCardReconcile(reconcileRunningCards(database.sqlite, Date.now()));

  const app = buildApp({
    database,
    logger: options.logger ?? true,
    ...(options.recorder === undefined ? {} : { recorder: options.recorder }),
    ...(options.extractionModel === undefined ? {} : { extractionModel: options.extractionModel }),
  });

  // Worktrees are durable and git already tracks them, so the board asks rather
  // than remembering. Without this a restart forgets every isolated branch: the
  // reviewer refuses to merge work that is sitting right there, and a
  // re-dispatched card falls back to running in the operator's own checkout.
  const adopted = await adoptWorktrees(app, database);

  await app.listen({ port, host });

  return {
    app,
    database,
    board,
    reconciled,
    reconciledCards,
    staleBuild: readBuildStamp().note,
    adopted,
    url: `http://${host}:${port}`,
    stop: async () => {
      await app.close();
      database.close();
    },
  };
}
