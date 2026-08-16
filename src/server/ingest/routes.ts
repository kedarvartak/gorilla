import { performance } from 'node:perf_hooks';

import type { FastifyInstance } from 'fastify';

import type { AppContext } from '../app.js';

/**
 * `POST /hooks/:event` - the hook path (doc 07).
 *
 * Three properties this handler must hold, in priority order:
 *
 * 1. Never block the agent. A hook sits in the agent's critical path and a
 *    board bug must not be why an unattended run stalls (doc 06, fail open).
 *    Every failure mode here still answers 2xx with an empty allow decision.
 * 2. Never lose an event. A payload that will not parse is stored raw rather
 *    than rejected, because the event is evidence even when its shape is not
 *    what we expected (doc 02, R7).
 * 3. Stay inside the latency budget. Nothing but the write happens before the
 *    response; synthesis, git and diffing are later phases and belong off this
 *    path entirely.
 */

/** Recorded per request so the benchmark and `doctor` (T8) can report on it. */
export interface LatencySample {
  readonly event: string;
  readonly durationMs: number;
}

const latencies: LatencySample[] = [];
const MAX_SAMPLES = 5_000;

export function recordedLatencies(): readonly LatencySample[] {
  return latencies;
}

export function clearRecordedLatencies(): void {
  latencies.length = 0;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Permissive field reads. Unknown fields are ignored and missing optional
 * fields tolerated, so a payload shape change degrades the correlation columns
 * rather than failing the request (R7).
 */
function readString(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

export function registerIngestRoutes(app: FastifyInstance, context: AppContext): void {
  // Claude Code always sends JSON, but a malformed body must not cost us the
  // event. Parse permissively and keep the raw text when it will not parse.
  app.addContentTypeParser(
    ['application/json', 'text/plain', '*/*'],
    { parseAs: 'string' },
    (_request, body, done) => {
      const text = typeof body === 'string' ? body : String(body);
      if (text.trim() === '') {
        done(null, {});
        return;
      }
      try {
        done(null, JSON.parse(text));
      } catch {
        done(null, { _gorilla_unparsed: text });
      }
    },
  );

  app.post<{ Params: { event: string } }>('/hooks/:event', (request, reply) => {
    const startedAt = performance.now();
    const receivedAt = Date.now();
    const payload = asRecord(request.body);

    // The URL is authoritative for the event name: it is what we configured,
    // whereas hook_event_name is data. They should agree; if they do not, the
    // mismatch is recorded rather than resolved silently.
    const event = request.params.event;
    const declared = readString(payload, 'hook_event_name');

    const sessionId = readString(payload, 'session_id');
    const cwd = readString(payload, 'cwd');

    if (sessionId === null || cwd === null) {
      // Nothing to attribute this to. Answer 2xx anyway - refusing would be a
      // failed hook in the agent's path for a problem it cannot fix.
      request.log.warn(
        { event, hasSession: sessionId !== null, hasCwd: cwd !== null },
        'hook event missing session_id or cwd; not persisted',
      );
      void reply.code(202).send({});
      return;
    }

    try {
      const written = context.store.write({
        eventName: event,
        sessionId,
        cwd,
        transcriptPath: readString(payload, 'transcript_path'),
        payload,
        receivedAt,
      });

      const durationMs = performance.now() - startedAt;
      if (latencies.length < MAX_SAMPLES) latencies.push({ event, durationMs });

      if (declared !== null && declared !== event) {
        request.log.warn({ event, declared }, 'hook_event_name disagrees with the route');
      }

      request.log.info(
        {
          event,
          seq: written.seq,
          runId: written.runId,
          runCreated: written.runCreated,
          durationMs: Number(durationMs.toFixed(2)),
        },
        'hook event ingested',
      );
    } catch (error) {
      // Fail open, loudly. The operator finds this in `doctor`; the agent
      // never sees it.
      request.log.error({ event, err: error }, 'failed to persist hook event');
    }

    // Phase 0 makes no decisions. An empty object is an explicit no-op: it
    // neither allows nor denies, leaving Claude Code's own behaviour intact.
    void reply.code(200).send({});
  });
}
