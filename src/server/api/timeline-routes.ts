import { existsSync } from 'node:fs';

import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';

import type { AppContext } from '../app.js';
import { runs } from '../db/schema.js';
import { notFound } from './errors.js';
import { parseObject } from '../json.js';
import { readTailWindow } from '../transcript/index.js';
import { densityOf, describeDensity, totalsOf } from '../timeline/density.js';
import { describeRepeats, repeatsIn } from '../timeline/repeats.js';

/**
 * Run timeline (P9).
 *
 * Paged, because a long session produces tens of thousands of events and
 * loading a run at once would stall the interface exactly when the operator is
 * trying to understand a long unattended run - the moment it matters most.
 */
export function registerTimelineRoutes(app: FastifyInstance, context: AppContext): void {
  app.get<{
    Params: { runId: string };
    Querystring: { after?: string; limit?: string; event?: string; tool?: string };
  }>('/api/runs/:runId/timeline', (request, reply) => {
    const { runId } = request.params;
    const after = Number(request.query.after ?? 0);
    const limit = Math.min(Math.max(Number(request.query.limit ?? 200), 1), 1000);

    const filters: string[] = ['run_id = ?'];
    const params: (string | number)[] = [runId];

    if (typeof request.query.event === 'string' && request.query.event !== '') {
      filters.push('event_name = ?');
      params.push(request.query.event);
    }
    if (typeof request.query.tool === 'string' && request.query.tool !== '') {
      filters.push('tool_name = ?');
      params.push(request.query.tool);
    }

    filters.push('seq > ?');
    params.push(Number.isFinite(after) ? after : 0);

    const rows = context.database.sqlite
      .prepare(
        `SELECT id, seq, event_name, received_at, tool_name, agent_id, payload
         FROM events WHERE ${filters.join(' AND ')} ORDER BY seq LIMIT ?`,
      )
      .all(...params, limit) as {
      id: number;
      seq: number;
      event_name: string;
      received_at: number;
      tool_name: string | null;
      agent_id: string | null;
      payload: string;
    }[];

    const total = (
      context.database.sqlite
        .prepare('SELECT COUNT(*) AS n FROM events WHERE run_id = ?')
        .get(runId) as { n: number }
    ).n;

    // Computed over the page rather than the whole run: the gaps between the
    // events on screen are the ones the operator is looking at. The totals
    // below say so, rather than implying they cover the run (T32).
    const repeats = repeatsIn(context.database.sqlite, runId);

    const density = densityOf(
      rows.map((row) => ({ event: row.event_name, receivedAt: row.received_at })),
    );
    const totals = totalsOf(density);

    return reply.send({
      runId,
      total,
      density: { ...totals, note: describeDensity(totals), overPage: true },
      // Over the whole run, not the page: a denial storm is exactly the thing
      // that spans more pages than anybody scrolls through (T33).
      repeats,
      repeatNote: describeRepeats(repeats),
      entries: rows.map((row, index) => {
        // Through the shared parser, not `JSON.parse` with a cast (T11). A
        // payload that is valid JSON but not an object - the events table only
        // rejects the unparseable - would otherwise be indexed as one, and the
        // reads below would be reading properties off a string.
        const payload = parseObject(row.payload);
        return {
          id: row.id,
          seq: row.seq,
          event: row.event_name,
          at: row.received_at,
          toolName: row.tool_name,
          // Subagent work happens in a context window the operator never sees,
          // so it is nested rather than flattened into the main sequence.
          agentId: row.agent_id,
          agentType: typeof payload['agent_type'] === 'string' ? payload['agent_type'] : null,
          triggerReason:
            typeof payload['trigger_reason'] === 'string' ? payload['trigger_reason'] : null,
          // Compaction is the discontinuity the whole screen is anchored on.
          isCompaction: row.event_name === 'PreCompact' || row.event_name === 'PostCompact',
          isTurnBoundary: row.event_name === 'Stop' || row.event_name === 'UserPromptSubmit',
          // What the interval before this event was spent on. A list of evenly
          // spaced events says a run happened and nothing about its shape.
          sinceMs: density[index]?.sinceMs ?? 0,
          interval: density[index]?.interval ?? 'start',
        };
      }),
      nextAfter: rows[rows.length - 1]?.seq ?? after,
      hasMore: rows.length === limit,
    });
  });

  /**
   * The conversation, not the events (T71).
   *
   * The board has stored a transcript path on every run since Phase 0 and has
   * never opened one. The timeline shows what the hooks saw - a tool asked
   * for, a tool answered - which is the shape of the work and not its
   * reasoning. The reasoning is on disk, in a file nothing has ever read back
   * to the operator.
   */
  app.get<{ Params: { runId: string }; Querystring: { chars?: string } }>(
    '/api/runs/:runId/transcript',
    async (request, reply) => {
      const run = context.database.db
        .select()
        .from(runs)
        .where(eq(runs.id, request.params.runId))
        .get();
      if (run === undefined) return notFound(reply, 'No such run.');

      if (run.transcriptPath === null) {
        // Not an error. An attached session that never reported one, or a run
        // from before the path was recorded, simply has nothing to open.
        return reply.send({ available: false, note: 'This run recorded no transcript path.' });
      }

      if (!existsSync(run.transcriptPath)) {
        // Said plainly rather than as an empty transcript. The file is
        // Claude Code's, not the board's, and it can be cleaned up underneath.
        return reply.send({
          available: false,
          note: `The transcript is no longer at ${run.transcriptPath}.`,
        });
      }

      const requested = Number(request.query.chars);
      const chars =
        Number.isFinite(requested) && requested > 0 ? Math.min(requested, 200_000) : 20_000;

      return reply.send({
        available: true,
        path: run.transcriptPath,
        // The tail, because the end of a run is what an operator reads first
        // and the whole thing can be megabytes.
        text: await readTailWindow(run.transcriptPath, chars),
        chars,
      });
    },
  );

  app.get<{ Params: { runId: string } }>('/api/runs/:runId/facets', (request, reply) => {
    const events = context.database.sqlite
      .prepare(
        'SELECT event_name AS name, COUNT(*) AS n FROM events WHERE run_id = ? GROUP BY event_name ORDER BY n DESC',
      )
      .all(request.params.runId) as { name: string; n: number }[];

    const tools = context.database.sqlite
      .prepare(
        'SELECT tool_name AS name, COUNT(*) AS n FROM events WHERE run_id = ? AND tool_name IS NOT NULL GROUP BY tool_name ORDER BY n DESC',
      )
      .all(request.params.runId) as { name: string; n: number }[];

    return reply.send({ events, tools });
  });
}
