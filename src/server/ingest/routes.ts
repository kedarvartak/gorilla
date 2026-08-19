import { performance } from 'node:perf_hooks';

import type { FastifyInstance } from 'fastify';

import type { AppContext } from '../app.js';
import { boardForCwd, claim, inferCard, sessionStartContext } from '../binding/attach.js';
import { getCard } from '../api/cards.js';
import { canonicaliseCwd } from './binding.js';
import { triggerFor } from '../ledger/service.js';
import { applyRunLifecycle } from './lifecycle.js';
import { parseGuardrails } from '../cards/guardrails.js';
import { ledgerEntries } from '../db/schema.js';
import { buildRepairBlock, eligibleForRepair, repairIsEmpty } from '../context/repair.js';
import { storedEntriesFor } from '../ledger/store.js';
import type { Card } from '../db/schema.js';

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
    /** Set by the write below, and read after the reply has been sent. */
    let extractFor: string | null = null;
    const startedAt = performance.now();
    const receivedAt = Date.now();
    const payload = asRecord(request.body);

    // The URL is authoritative for the event name: it is what we configured,
    // whereas hook_event_name is data. They should agree; if they do not, the
    // mismatch is recorded rather than resolved silently.
    const event = request.params.event;
    const declared = readString(payload, 'hook_event_name');

    // Recorded before anything else, and before validation: a fixture should
    // capture what actually arrived, including the malformed deliveries that
    // are the most valuable ones to be able to replay.
    if (context.recorder !== undefined) {
      try {
        context.recorder.record(event, payload, receivedAt);
      } catch (error) {
        request.log.error({ event, err: error }, 'failed to record fixture entry');
      }
    }

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

      // Recorded, not started: extraction reads the transcript and may call an
      // API, and this handler is in the agent's critical path (doc 06).
      if (triggerFor(event) !== null) extractFor = written.runId;

      // A single indexed update, so it stays on this path: a run that reads as
      // live after it ended is the stale signal the board exists to remove.
      applyRunLifecycle(context.database.sqlite, {
        runId: written.runId,
        eventName: event,
        receivedAt,
        payload,
      });

      // Watches for a run that has stopped getting anywhere. Cheap enough for
      // this path, and it is the only place that sees a run which never ends -
      // the checks in the dispatcher's settle path never reach one of those.
      context.dispatcher.observe(written.runId, receivedAt);

      // Published after the write, so a subscriber can never observe an event
      // the database does not have. The broadcaster swallows subscriber errors
      // so a stuck browser cannot slow the agent.
      context.broadcaster.publish('hook', {
        id: written.seq,
        runId: written.runId,
        // Attributed at the source. Without it the activity view can show that
        // something is happening but not which card it is happening to, which
        // is most of what the operator wants from it.
        cardId: written.cardId,
        sessionId,
        event,
        receivedAt,
        toolName: readString(payload, 'tool_name'),
        // The one field that turns "Edit" into something recognisable.
        target:
          readString(asRecord(payload['tool_input']), 'file_path') ??
          readString(asRecord(payload['tool_input']), 'command'),
        agentId: readString(payload, 'agent_id'),
        cwd,
        durationMs: Number(durationMs.toFixed(2)),
      });

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

    // SessionStart is the one event that answers with something. Everything
    // else gets an explicit no-op: an empty object neither allows nor denies,
    // leaving Claude Code's own behaviour intact.
    if (event === 'SessionStart') {
      void reply
        .code(200)
        .send(sessionStartResponse(context, sessionId, cwd, readString(payload, 'source')));
      return;
    }

    void reply.code(200).send({});

    // After the response. `Stop` and `PreCompact` close a window worth
    // synthesising, and PreCompact's is the one whose content is about to stop
    // existing - but neither may hold the agent up while we do it.
    if (extractFor !== null) void context.extraction.enqueue(extractFor, event);
  });
}

/**
 * The reply to a starting session (doc 07 section 3, doc 12 output 3).
 *
 * Three jobs now. Tell the operator the board is watching and how to bind a
 * card; make sure an unclaimed session still lands somewhere; and, when this
 * `SessionStart` is the one that follows a compaction, hand the agent back what
 * the compaction took.
 *
 * That last one is the highest-leverage thing the board does. Everything else
 * makes the operator better informed after the fact; this makes the agent less
 * likely to do the wrong thing in the first place, using material already
 * captured for another purpose, at the cost of one hook response.
 *
 * Never throws - a failure here would mean a session that cannot start.
 */
function sessionStartResponse(
  context: AppContext,
  sessionId: string,
  cwd: string,
  source: string | null,
): Record<string, unknown> {
  try {
    const board = boardForCwd(context.database, canonicaliseCwd(cwd));
    if (board === null) return {};

    const run = context.store.runForSession(sessionId);
    const bound =
      run?.cardId === null || run?.cardId === undefined
        ? null
        : getCard(context.database, run.cardId);

    // A card the operator chose, as opposed to a provisional one the board
    // invented. Only the first is worth repairing against or greeting as bound:
    // a provisional card holds a session's events so none are lost, and telling
    // its session it is "bound" would hide the fact that nobody claimed it.
    let claimed = bound;

    if (bound === null && run !== null) {
      // A launch the board is expecting takes precedence over inference.
      // Without this, a dispatched session is captured by a provisional card
      // and the card that launched it shows no evidence at all (doc 17).
      const expected = context.pending.claim(canonicaliseCwd(cwd));

      if (expected !== null) {
        claim(context.database, sessionId, expected);
        claimed = getCard(context.database, expected);
      } else {
        // Otherwise it is a terminal session, and an event with nowhere to go
        // is the blind spot this product exists to remove (doc 05).
        inferCard(context.database, run.id, null);
      }
    }

    const repair =
      source === 'compact' && claimed !== null
        ? repairFor(context, claimed, run?.id ?? null)
        : null;

    return {
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext:
          repair ?? sessionStartContext(context.database, board.id, board.name, claimed),
      },
    };
  } catch {
    return {};
  }
}

/**
 * The repair block for a card whose session has just been compacted.
 *
 * Eligibility is decided here, where the run each entry came from is known, and
 * enforced by `eligibleForRepair`. Returns null when there is nothing certain
 * enough to say, because a session start that injects nothing is strictly better
 * than one that injects something stale: the agent will act on whatever it is
 * handed (doc 12).
 */
function repairFor(context: AppContext, card: Card, runId: string | null): string | null {
  try {
    const runOf = new Map(
      context.database.db
        .select({ id: ledgerEntries.id, runId: ledgerEntries.runId })
        .from(ledgerEntries)
        .all()
        .map((row) => [row.id, row.runId] as const),
    );

    const entries = storedEntriesFor(context.database, card.id).filter((entry) =>
      eligibleForRepair(entry, { runId, entryRunId: runOf.get(entry.id) ?? null }),
    );

    const block = buildRepairBlock({
      cardTitle: card.title,
      guardrails: parseGuardrails(card.guardrails),
      entries,
    });

    return repairIsEmpty(block) ? null : block.text;
  } catch {
    // A failure here must not stop the session. Falling through to the ordinary
    // greeting loses the repair and nothing else.
    return null;
  }
}
