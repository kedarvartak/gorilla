import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../app.js';

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

    return reply.send({
      runId,
      total,
      entries: rows.map((row) => {
        const payload = JSON.parse(row.payload) as Record<string, unknown>;
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
        };
      }),
      nextAfter: rows[rows.length - 1]?.seq ?? after,
      hasMore: rows.length === limit,
    });
  });

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
