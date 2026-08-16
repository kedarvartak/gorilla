import type { FastifyInstance, FastifyReply } from 'fastify';

import type { AppContext } from '../app.js';
import type { StreamEvent } from './broadcaster.js';

/**
 * `GET /stream` - Server-Sent Events for the live view.
 *
 * Phase 0 uses this to make the pipe visible during the verification run. The
 * board in Phase 1 consumes the same endpoint.
 */

/** Comments keep proxies and idle-connection reapers from closing the stream. */
const KEEPALIVE_MS = 15_000;

function serialise(entry: StreamEvent): string {
  return `id: ${entry.id}\nevent: ${entry.event}\ndata: ${JSON.stringify(entry.data)}\n\n`;
}

function parseLastEventId(header: string | string[] | undefined): number {
  const raw = Array.isArray(header) ? header[0] : header;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
}

export function registerStreamRoutes(app: FastifyInstance, context: AppContext): void {
  /**
   * An SSE response is an open request, and Fastify's close() waits for open
   * requests. Without ending them explicitly, shutdown hangs until every
   * browser tab goes away - which in tests means the next server cannot bind
   * the port, and in production means Ctrl+C appears not to work.
   */
  const open = new Set<FastifyReply>();

  app.addHook('onClose', (_instance, done) => {
    for (const reply of open) {
      reply.raw.end();
    }
    open.clear();
    done();
  });

  app.get('/stream', (request, reply: FastifyReply) => {
    open.add(reply);
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      // Proxy buffering would defeat the point of a stream.
      'x-accel-buffering': 'no',
    });

    // Flush immediately and announce the connection. Without this, a client
    // connecting to an idle board writes no bytes, Node holds the headers in
    // its buffer, and the client hangs waiting for a stream that is in fact
    // open. The comment line is ignored by EventSource and costs nothing.
    reply.raw.flushHeaders();
    reply.raw.write(': connected\n\n');

    const lastEventId = parseLastEventId(
      request.headers['last-event-id'] ?? (request.query as { lastEventId?: string }).lastEventId,
    );

    if (context.broadcaster.hasGapBefore(lastEventId)) {
      // Say so rather than silently serving an incomplete stream: SQLite holds
      // the full record and the client can backfill from it.
      reply.raw.write(
        `event: gap\ndata: ${JSON.stringify({
          message: 'Reconnected beyond the replay buffer; some events were not replayed.',
          lastEventId,
        })}\n\n`,
      );
    }

    for (const missed of context.broadcaster.since(lastEventId)) {
      reply.raw.write(serialise(missed));
    }

    const unsubscribe = context.broadcaster.subscribe((entry) => {
      reply.raw.write(serialise(entry));
    });

    const keepalive = setInterval(() => {
      reply.raw.write(': keepalive\n\n');
    }, KEEPALIVE_MS);
    keepalive.unref?.();

    const cleanup = (): void => {
      clearInterval(keepalive);
      unsubscribe();
      open.delete(reply);
    };

    request.raw.on('close', cleanup);
    request.raw.on('error', cleanup);
  });
}
