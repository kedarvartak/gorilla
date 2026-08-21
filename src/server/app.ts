import Fastify, { type FastifyInstance } from 'fastify';

import type { DatabaseHandle } from './db/client.js';
import type { FixtureRecorder } from './fixtures/recorder.js';
import { EventStore } from './ingest/store.js';
import { registerIngestRoutes, recordedLatencies } from './ingest/routes.js';
import { Broadcaster } from './stream/broadcaster.js';
import { registerStreamRoutes } from './stream/routes.js';
import { registerWebRoutes } from './web/routes.js';
import {
  registerApiRoutes,
  registerBindingRoutes,
  registerCardDetailRoutes,
  registerDispatchRoutes,
  registerPlanRoutes,
  registerBriefRoutes,
  registerReviewRoutes,
  registerTimelineRoutes,
} from './api/routes.js';
import { eq } from 'drizzle-orm';

import { Dispatcher } from './dispatch/dispatcher.js';
import { boards } from './db/schema.js';
import { NOTIFY_ENV, notifyHalt } from './notify/notify.js';
import { PendingBindings } from './binding/pending.js';
import { ExtractionService } from './ledger/service.js';
import type { ExtractionModel } from './ledger/model.js';

export interface AppOptions {
  readonly database: DatabaseHandle;
  /** Fastify logger options, or false to silence it (tests). */
  readonly logger?: boolean;
  /** When set, every received hook event is also written to a fixture (T5). */
  readonly recorder?: FixtureRecorder;
  /**
   * The extraction model. Absent means mechanical entries only - and absent is
   * the default deliberately, so that building an app never spends money
   * because a key happened to be exported. `serve` supplies the real one.
   */
  readonly extractionModel?: ExtractionModel;
}

export interface AppContext {
  readonly store: EventStore;
  readonly database: DatabaseHandle;
  readonly recorder?: FixtureRecorder | undefined;
  readonly broadcaster: Broadcaster;
  readonly dispatcher: Dispatcher;
  readonly pending: PendingBindings;
  readonly extraction: ExtractionService;
}

/**
 * The context behind a built app.
 *
 * A WeakMap rather than a Fastify decorator: the routes already close over the
 * context, so this exists purely so a test can reach the extraction service and
 * await work that the hook path deliberately does not await.
 */
const contexts = new WeakMap<FastifyInstance, AppContext>();

export function contextOf(app: FastifyInstance): AppContext | undefined {
  return contexts.get(app);
}

export function buildApp(options: AppOptions): FastifyInstance {
  const app = Fastify({
    logger: options.logger ?? false,
    // Hook payloads carry tool inputs and responses, which include file
    // contents. The default 1MB limit would reject them.
    bodyLimit: 32 * 1024 * 1024,
  });

  const broadcaster = new Broadcaster();
  const pending = new PendingBindings();

  const context: AppContext = {
    store: new EventStore(options.database.sqlite),
    database: options.database,
    recorder: options.recorder,
    broadcaster,
    pending,
    extraction: new ExtractionService({
      database: options.database,
      model: options.extractionModel,
      events: {
        // The interface refreshes the brief on this rather than polling: the
        // entries appear seconds after the turn that produced them.
        onExtracted: (summary) => broadcaster.publish('ledger', summary),
      },
    }),
    dispatcher: new Dispatcher(options.database, pending, {
      onStateChange: (boardId, state) => broadcaster.publish('dispatch-state', { boardId, state }),
      onRunStarted: (boardId, cardId, sessionId) =>
        broadcaster.publish('run-started', { boardId, cardId, sessionId }),
      // A halt nobody hears about at 2am is indistinguishable from a queue
      // that ran all night. The command is the operator's own, from the
      // environment, so it survives a restart.
      onHalted: (boardId, halt) => {
        broadcaster.publish('dispatch-halted', { boardId, halt });

        const board = options.database.db.select().from(boards).where(eq(boards.id, boardId)).get();

        notifyHalt({
          halt,
          boardName: board?.name ?? 'gorilla',
          command: process.env[NOTIFY_ENV],
          cwd: board?.cwd,
          onError: (error) => app.log.error({ err: error }, 'halt notification failed'),
        });
      },
      // Published so a watching interface can tell a card that went back in the
      // queue from one that never started. Both read as idle on the board.
      onRetried: (boardId, cardId, why) =>
        broadcaster.publish('card-retried', { boardId, cardId, why }),
      onRunFinished: (boardId, cardId, result) =>
        broadcaster.publish('run-finished', {
          boardId,
          cardId,
          outcome: result.outcome,
          sessionId: result.sessionId,
        }),
    }),
  };

  // Cancel anything still running when the board stops, rather than leaving
  // claude processes against the operator's repository with nothing watching.
  app.addHook('onClose', async () => {
    await context.dispatcher.shutdown();
    // Entries already paid for are worth waiting for; the window they came
    // from will not exist again.
    await context.extraction.drain();
  });

  app.get('/health', () => ({ status: 'ok' }));

  // Latency lives in the process, so T10's report can only read it while the
  // server that received the events is still running.
  const startedAt = Date.now();
  app.get('/diagnostics', () => {
    const samples = recordedLatencies()
      .map((sample) => sample.durationMs)
      .sort((a, b) => a - b);

    const quantile = (q: number): number =>
      samples.length === 0
        ? 0
        : (samples[Math.min(samples.length - 1, Math.floor(q * samples.length))] ?? 0);

    return {
      uptimeMs: Date.now() - startedAt,
      samples: samples.length,
      p50: quantile(0.5),
      p95: quantile(0.95),
      p99: quantile(0.99),
      max: samples[samples.length - 1] ?? 0,
    };
  });

  registerIngestRoutes(app, context);
  registerStreamRoutes(app, context);
  registerApiRoutes(app, context);
  registerDispatchRoutes(app, context);
  registerPlanRoutes(app, context);
  registerBindingRoutes(app, context);
  registerCardDetailRoutes(app, context);
  registerTimelineRoutes(app, context);
  registerReviewRoutes(app, context);
  registerBriefRoutes(app, context);
  registerWebRoutes(app);

  contexts.set(app, context);

  return app;
}
