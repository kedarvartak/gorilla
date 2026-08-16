import Fastify, { type FastifyInstance } from 'fastify';

import type { DatabaseHandle } from './db/client.js';
import type { FixtureRecorder } from './fixtures/recorder.js';
import { EventStore } from './ingest/store.js';
import { registerIngestRoutes } from './ingest/routes.js';
import { Broadcaster } from './stream/broadcaster.js';
import { registerStreamRoutes } from './stream/routes.js';
import { registerWebRoutes } from './web/routes.js';

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
}

export function buildApp(options: AppOptions): FastifyInstance {
  const app = Fastify({
    logger: options.logger ?? false,
    // Hook payloads carry tool inputs and responses, which include file
    // contents. The default 1MB limit would reject them.
    bodyLimit: 32 * 1024 * 1024,
  });

  const context: AppContext = {
    store: new EventStore(options.database.sqlite),
    database: options.database,
    recorder: options.recorder,
    broadcaster: new Broadcaster(),
  };

  app.get('/health', () => ({ status: 'ok' }));

  registerIngestRoutes(app, context);
  registerStreamRoutes(app, context);
  registerWebRoutes(app);

  return app;
}
