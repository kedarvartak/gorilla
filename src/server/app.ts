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
  registerTimelineRoutes,
} from './api/routes.js';
import { Dispatcher } from './dispatch/dispatcher.js';
import { PendingBindings } from './binding/pending.js';

export interface AppOptions {
  readonly database: DatabaseHandle;
  /** Fastify logger options, or false to silence it (tests). */
  readonly logger?: boolean;
  /** When set, every received hook event is also written to a fixture (T5). */
  readonly recorder?: FixtureRecorder;
}

export interface AppContext {
  readonly store: EventStore;
  readonly database: DatabaseHandle;
  readonly recorder?: FixtureRecorder | undefined;
  readonly broadcaster: Broadcaster;
  readonly dispatcher: Dispatcher;
  readonly pending: PendingBindings;
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
    dispatcher: new Dispatcher(options.database, pending, {
      onStateChange: (boardId, state) => broadcaster.publish('dispatch-state', { boardId, state }),
      onRunStarted: (boardId, cardId, sessionId) =>
        broadcaster.publish('run-started', { boardId, cardId, sessionId }),
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
  registerWebRoutes(app);

  return app;
}
