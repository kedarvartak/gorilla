import { randomUUID } from 'node:crypto';

import { asc, eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply } from 'fastify';

import type { AppContext } from '../app.js';
import { createDefaultColumns } from '../cards/defaults.js';
import { describeGuardrails, parseGuardrails } from '../cards/guardrails.js';
import { blockersFor, dispatchableCards } from '../cards/eligibility.js';
import { canonicaliseCwd } from '../ingest/binding.js';
import { boards, cardDependencies, columns, runs, type Card } from '../db/schema.js';
import {
  addDependency,
  CardError,
  createCard,
  deleteCard,
  getCard,
  listCards,
  markSeen,
  moveCard,
  removeDependency,
  updateCard,
} from './cards.js';
import { createPlan, getPlan, guardrailNote } from './plans.js';
import { claim, claimableCards, mergeCard } from '../binding/attach.js';
import { buildMechanicalLedger } from '../ledger/mechanical.js';
import { checkReality, describeReality } from '../ledger/reality.js';
import { describeVerify } from '../verify/run.js';
import { buildBrief, renderBrief } from '../brief/brief.js';
import type { StoredEntry } from '../ledger/dedupe.js';
import { cursorFor, entryTimesFor, storedEntriesFor } from '../ledger/store.js';
import { describeMergeReport, mergeBranches } from '../review/merge.js';

/**
 * REST for boards, columns and cards.
 *
 * Every mutation publishes on the SSE stream, so an interface never has to
 * poll and a second tab stays correct. Validation failures name the field, so
 * the interface can put the message where the operator is looking rather than
 * showing a bare 400.
 */

function fail(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof CardError) {
    return reply.code(error.status).send({
      error: error.message,
      ...(error.field === undefined ? {} : { field: error.field }),
    });
  }
  throw error;
}

/** Guardrails are stored as JSON; the interface wants them parsed and described. */
function publish(context: AppContext, event: string, data: unknown): void {
  context.broadcaster.publish(event, data);
}

function present(card: Card): Record<string, unknown> {
  const guardrails = parseGuardrails(card.guardrails);
  return {
    ...card,
    guardrails,
    // Sent alongside so the interface cannot accidentally present an advisory
    // rule as though it were enforced (R10).
    guardrailDetail: describeGuardrails(guardrails),
  };
}

export function registerApiRoutes(app: FastifyInstance, context: AppContext): void {
  const publish = (event: string, data: unknown): void => {
    context.broadcaster.publish(event, data);
  };

  app.get('/api/boards', () => {
    return context.database.db.select().from(boards).orderBy(asc(boards.createdAt)).all();
  });

  app.post<{ Body: { name?: string; cwd?: string } }>('/api/boards', (request, reply) => {
    const name = (request.body?.name ?? '').trim();
    const cwd = (request.body?.cwd ?? '').trim();

    if (cwd === '') {
      return reply.code(400).send({ error: 'A board needs a working directory.', field: 'cwd' });
    }

    const canonical = canonicaliseCwd(cwd);
    const existing = context.database.db
      .select()
      .from(boards)
      .where(eq(boards.cwd, canonical))
      .get();

    if (existing !== undefined) {
      // One board per directory: events route by cwd, so two boards on one
      // directory would make attribution ambiguous.
      return reply
        .code(409)
        .send({ error: 'A board already exists for that directory.', field: 'cwd' });
    }

    const id = randomUUID();
    context.database.db
      .insert(boards)
      .values({
        id,
        name: name === '' ? (canonical.split(/[/\\]/).pop() ?? canonical) : name,
        cwd: canonical,
        createdAt: Date.now(),
      })
      .run();

    createDefaultColumns(context.database.db, id);

    const board = context.database.db.select().from(boards).where(eq(boards.id, id)).get();
    publish('board-created', board);
    return reply.code(201).send(board);
  });

  app.get<{ Params: { boardId: string } }>('/api/boards/:boardId/columns', (request) => {
    return context.database.db
      .select()
      .from(columns)
      .where(eq(columns.boardId, request.params.boardId))
      .orderBy(asc(columns.position))
      .all();
  });

  app.get<{ Params: { boardId: string } }>('/api/boards/:boardId/cards', (request) => {
    return listCards(context.database, request.params.boardId).map(present);
  });

  app.get<{ Params: { boardId: string } }>('/api/boards/:boardId/dispatchable', (request) => {
    return dispatchableCards(context.database.db, request.params.boardId);
  });

  app.post<{ Params: { boardId: string }; Body: Record<string, unknown> }>(
    '/api/boards/:boardId/cards',
    (request, reply) => {
      try {
        const body = request.body ?? {};
        const card = createCard(context.database, {
          boardId: request.params.boardId,
          // Not String(): coercing an object would silently create a card
          // titled "[object Object]" instead of rejecting the request.
          title: typeof body['title'] === 'string' ? body['title'] : '',
          body: typeof body['body'] === 'string' ? body['body'] : '',
          ...(typeof body['columnId'] === 'string' ? { columnId: body['columnId'] } : {}),
          ...(typeof body['index'] === 'number' ? { index: body['index'] } : {}),
          ...(body['goalCondition'] === undefined
            ? {}
            : { goalCondition: body['goalCondition'] as string | null }),
          ...(body['guardrails'] === undefined ? {} : { guardrails: body['guardrails'] }),
          ...(body['agentModel'] === undefined
            ? {}
            : { agentModel: body['agentModel'] as string | null }),
          ...(body['synthesisModel'] === undefined
            ? {}
            : { synthesisModel: body['synthesisModel'] as string | null }),
        });

        publish('card-created', present(card));
        return reply.code(201).send(present(card));
      } catch (error) {
        return fail(reply, error);
      }
    },
  );

  app.get<{ Params: { cardId: string } }>('/api/cards/:cardId', (request, reply) => {
    try {
      const card = getCard(context.database, request.params.cardId);
      return reply.send({
        ...present(card),
        blockers: blockersFor(context.database.db, card.id),
        dependsOn: context.database.db
          .select({ id: cardDependencies.dependsOnCardId })
          .from(cardDependencies)
          .where(eq(cardDependencies.cardId, card.id))
          .all()
          .map((row) => row.id),
      });
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.patch<{ Params: { cardId: string }; Body: Record<string, unknown> }>(
    '/api/cards/:cardId',
    (request, reply) => {
      try {
        const body = request.body ?? {};
        const card = updateCard(context.database, request.params.cardId, {
          ...(typeof body['title'] === 'string' ? { title: body['title'] } : {}),
          ...(typeof body['body'] === 'string' ? { body: body['body'] } : {}),
          ...(body['goalCondition'] === undefined
            ? {}
            : { goalCondition: body['goalCondition'] as string | null }),
          ...(body['guardrails'] === undefined ? {} : { guardrails: body['guardrails'] }),
          ...(body['agentModel'] === undefined
            ? {}
            : { agentModel: body['agentModel'] as string | null }),
          // Editable for the same reason `agentModel` is: the model that reads a
          // card's history is a per-card choice, and creation is not the only
          // moment the operator makes it.
          ...(body['synthesisModel'] === undefined
            ? {}
            : { synthesisModel: body['synthesisModel'] as string | null }),
          ...(body['status'] === undefined ? {} : { status: body['status'] as Card['status'] }),
        });

        publish('card-updated', present(card));
        return reply.send(present(card));
      } catch (error) {
        return fail(reply, error);
      }
    },
  );

  app.post<{ Params: { cardId: string }; Body: { columnId?: string; index?: number } }>(
    '/api/cards/:cardId/move',
    (request, reply) => {
      try {
        const columnId = request.body?.columnId;
        if (typeof columnId !== 'string') {
          return reply
            .code(400)
            .send({ error: 'A move needs a target column.', field: 'columnId' });
        }

        const card = moveCard(
          context.database,
          request.params.cardId,
          columnId,
          request.body?.index ?? 0,
        );
        publish('card-moved', present(card));
        return reply.send(present(card));
      } catch (error) {
        return fail(reply, error);
      }
    },
  );

  app.post<{ Params: { cardId: string } }>('/api/cards/:cardId/seen', (request, reply) => {
    try {
      const card = markSeen(context.database, request.params.cardId);
      publish('card-seen', present(card));
      return reply.send(present(card));
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.post<{ Params: { cardId: string }; Body: { dependsOn?: string } }>(
    '/api/cards/:cardId/dependencies',
    (request, reply) => {
      try {
        const dependsOn = request.body?.dependsOn;
        if (typeof dependsOn !== 'string') {
          return reply.code(400).send({ error: 'Name the card depended on.', field: 'dependsOn' });
        }

        addDependency(context.database, request.params.cardId, dependsOn);
        publish('card-dependencies-changed', { cardId: request.params.cardId });
        return reply.code(204).send();
      } catch (error) {
        return fail(reply, error);
      }
    },
  );

  app.delete<{ Params: { cardId: string; dependsOn: string } }>(
    '/api/cards/:cardId/dependencies/:dependsOn',
    (request, reply) => {
      removeDependency(context.database, request.params.cardId, request.params.dependsOn);
      publish('card-dependencies-changed', { cardId: request.params.cardId });
      return reply.code(204).send();
    },
  );

  app.delete<{ Params: { cardId: string } }>('/api/cards/:cardId', (request, reply) => {
    try {
      deleteCard(context.database, request.params.cardId);
      publish('card-deleted', { id: request.params.cardId });
      return reply.code(204).send();
    } catch (error) {
      return fail(reply, error);
    }
  });
}

/**
 * Dispatch control (P8).
 *
 * Separate from the card routes because dispatching is an action on the board,
 * not an edit to a card, and the operator reasons about it that way.
 */
export function registerDispatchRoutes(app: FastifyInstance, context: AppContext): void {
  app.get<{ Params: { boardId: string } }>('/api/boards/:boardId/dispatch', (request) => {
    return context.dispatcher.state(request.params.boardId);
  });

  app.post<{
    Params: { boardId: string };
    Body: { mode?: string; concurrency?: number; policy?: string };
  }>('/api/boards/:boardId/dispatch', (request, reply) => {
    const { boardId } = request.params;
    const mode = request.body?.mode;
    const concurrency = request.body?.concurrency;
    const policy = request.body?.policy;

    if (mode !== undefined && mode !== 'manual' && mode !== 'automatic') {
      return reply.code(400).send({ error: 'Mode must be manual or automatic.', field: 'mode' });
    }
    if (policy !== undefined && policy !== 'review' && policy !== 'unattended') {
      return reply
        .code(400)
        .send({ error: 'Policy must be review or unattended.', field: 'policy' });
    }
    if (concurrency !== undefined && (!Number.isInteger(concurrency) || concurrency < 1)) {
      return reply
        .code(400)
        .send({ error: 'Concurrency must be a positive integer.', field: 'concurrency' });
    }

    if (concurrency !== undefined) context.dispatcher.setConcurrency(boardId, concurrency);
    if (policy !== undefined) context.dispatcher.setPolicy(boardId, policy);
    if (mode !== undefined) context.dispatcher.setMode(boardId, mode);

    return reply.send(context.dispatcher.state(boardId));
  });

  app.get<{ Params: { boardId: string } }>(
    '/api/boards/:boardId/worktrees',
    async (request, reply) => {
      const board = context.database.db
        .select()
        .from(boards)
        .where(eq(boards.id, request.params.boardId))
        .get();

      if (board === undefined) return reply.code(404).send({ error: 'No such board.' });

      const manager = context.dispatcher.worktreesFor(board.cwd);
      const workspaces = await Promise.all(
        manager.list().map(async (workspace) => ({
          ...workspace,
          status: await manager.statusOf(workspace.cardId),
        })),
      );

      return reply.send(workspaces);
    },
  );

  app.delete<{ Params: { boardId: string; cardId: string }; Querystring: { force?: string } }>(
    '/api/boards/:boardId/cards/:cardId/worktree',
    async (request, reply) => {
      const board = context.database.db
        .select()
        .from(boards)
        .where(eq(boards.id, request.params.boardId))
        .get();

      if (board === undefined) return reply.code(404).send({ error: 'No such board.' });

      // Removal is an operator action. A worktree holds a night of an agent's
      // work and is never cleaned up automatically (doc 18).
      const result = await context.dispatcher
        .worktreesFor(board.cwd)
        .remove(request.params.cardId, { force: request.query.force === 'true' });

      return result.ok
        ? reply.send({ removed: true })
        : reply.code(409).send({ error: result.reason });
    },
  );

  app.post<{ Params: { boardId: string } }>(
    '/api/boards/:boardId/dispatch/resume',
    (request, reply) => {
      return reply.send(context.dispatcher.resume(request.params.boardId));
    },
  );

  app.post<{ Params: { boardId: string; cardId: string } }>(
    '/api/boards/:boardId/cards/:cardId/dispatch',
    (request, reply) => {
      try {
        const running = context.dispatcher.dispatch(request.params.boardId, request.params.cardId);

        if (running === null) {
          // The dispatcher records why in the halt state rather than throwing,
          // so the reason survives for the operator to read.
          return reply.code(409).send({
            error: 'The card could not be dispatched.',
            state: context.dispatcher.state(request.params.boardId),
          });
        }

        return reply.code(202).send(context.dispatcher.state(request.params.boardId));
      } catch (error) {
        return fail(reply, error);
      }
    },
  );

  app.post<{ Params: { boardId: string; cardId: string } }>(
    '/api/boards/:boardId/cards/:cardId/cancel',
    (request, reply) => {
      const cancelled = context.dispatcher.cancel(request.params.boardId, request.params.cardId);
      return reply.code(cancelled ? 202 : 409).send({ cancelled });
    },
  );
}

/** Plan intake (P6, doc 07 section 2). */
export function registerPlanRoutes(app: FastifyInstance, context: AppContext): void {
  app.post<{ Params: { boardId: string }; Body: Record<string, unknown> }>(
    '/api/boards/:boardId/plans',
    (request, reply) => {
      try {
        const result = createPlan(context.database, request.params.boardId, request.body ?? {});

        for (const card of result.cards) publish(context, 'card-created', present(card));
        publish(context, 'plan-created', { planId: result.planId, cards: result.cards.length });

        // The response is written to be read back into a conversation, so it
        // states what to do rather than only what happened.
        return reply.code(201).send({
          planId: result.planId,
          created: result.cards.map((card) => ({
            id: card.id,
            title: card.title,
            guardrails: guardrailNote(card),
          })),
          warnings: result.warnings,
          unresolvedDependencies: result.unresolvedDependencies,
          next:
            result.warnings.length === 0
              ? 'All cards validated. Promote the ones you want run to the Ready column.'
              : 'Some cards have warnings. Fix them here, while the context that produced them is still loaded, then re-post.',
        });
      } catch (error) {
        return fail(reply, error);
      }
    },
  );

  app.get<{ Params: { planId: string } }>('/api/plans/:planId', (request, reply) => {
    try {
      return reply.send(getPlan(context.database, request.params.planId));
    } catch (error) {
      return fail(reply, error);
    }
  });
}

/** Attached-mode binding (P10). */
export function registerBindingRoutes(app: FastifyInstance, context: AppContext): void {
  app.post<{ Body: { sessionId?: string; cardId?: string } }>('/api/claim', (request, reply) => {
    const sessionId = request.body?.sessionId;
    const cardId = request.body?.cardId;

    if (typeof sessionId !== 'string') {
      return reply.code(400).send({ error: 'A claim needs a session id.', field: 'sessionId' });
    }
    if (typeof cardId !== 'string') {
      return reply.code(400).send({ error: 'A claim needs a card id.', field: 'cardId' });
    }

    try {
      const result = claim(context.database, sessionId, cardId);
      publish(context, 'session-claimed', result);
      return reply.send(result);
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.post<{ Params: { cardId: string }; Body: { into?: string } }>(
    '/api/cards/:cardId/merge',
    (request, reply) => {
      const into = request.body?.into;
      if (typeof into !== 'string') {
        return reply.code(400).send({ error: 'Name the card to merge into.', field: 'into' });
      }

      try {
        const result = mergeCard(context.database, request.params.cardId, into);
        publish(context, 'card-merged', result);
        return reply.send(result);
      } catch (error) {
        return fail(reply, error);
      }
    },
  );

  app.get<{ Params: { boardId: string } }>('/api/boards/:boardId/claimable', (request) => {
    return claimableCards(context.database, request.params.boardId).map(present);
  });
}

/**
 * Card detail (P4).
 *
 * One request returns everything the detail view needs - specification, run
 * history, and the mechanical ledger - because three round trips to render one
 * card is three chances for the panes to disagree with each other.
 */
export function registerCardDetailRoutes(app: FastifyInstance, context: AppContext): void {
  app.get<{ Params: { cardId: string } }>('/api/cards/:cardId/detail', async (request, reply) => {
    try {
      const card = getCard(context.database, request.params.cardId);
      const guardrails = parseGuardrails(card.guardrails);

      const cardRuns = context.database.db
        .select()
        .from(runs)
        .where(eq(runs.cardId, card.id))
        .orderBy(asc(runs.startedAt))
        .all();

      const ledgers = cardRuns.map((run) => ({
        runId: run.id,
        sessionId: run.sessionId,
        startedAt: run.startedAt,
        endedAt: run.endedAt,
        gitBranch: run.gitBranch,
        events: (
          context.database.sqlite
            .prepare('SELECT COUNT(*) AS n FROM events WHERE run_id = ?')
            .get(run.id) as { n: number }
        ).n,
        ledger: buildMechanicalLedger({ sqlite: context.database.sqlite, runId: run.id }),
      }));

      // Git is the only source here independent of the agent, so it is the one
      // that can contradict it (doc 08, claim versus reality).
      const board = context.database.db
        .select()
        .from(boards)
        .where(eq(boards.id, card.boardId))
        .get();
      const claimed = ledgers.flatMap((entry) => entry.ledger.changed);
      const reality =
        board === undefined
          ? null
          : await checkReality({
              cwd: board.cwd,
              headShaAtStart: cardRuns[0]?.headShaAtStart ?? null,
              claimedPaths: claimed,
            });

      const verify = context.dispatcher.verifyResultFor(card.id);

      return reply.send({
        card: present(card),
        guardrails,
        guardrailDetail: describeGuardrails(guardrails),
        // What the board checked, rather than what the agent claimed.
        verify: verify ?? null,
        verifyNote: verify === undefined ? null : describeVerify(verify),
        blockers: blockersFor(context.database.db, card.id),
        runs: ledgers,
        reality,
        realityNotes: reality === null ? [] : describeReality(reality),
      });
    } catch (error) {
      return fail(reply, error);
    }
  });
}

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

/**
 * The reviewer (P4/U4).
 *
 * One action for "merge last night's branches and tell me if anything broke".
 * The operator names the cards; nothing is merged automatically, and nothing
 * is pushed.
 */
export function registerReviewRoutes(app: FastifyInstance, context: AppContext): void {
  app.post<{
    Params: { boardId: string };
    Body: { cardIds?: unknown; into?: string; verify?: string | null };
  }>('/api/boards/:boardId/review/merge', async (request, reply) => {
    const board = context.database.db
      .select()
      .from(boards)
      .where(eq(boards.id, request.params.boardId))
      .get();

    if (board === undefined) return reply.code(404).send({ error: 'No such board.' });

    const cardIds = Array.isArray(request.body?.cardIds)
      ? (request.body.cardIds as unknown[]).filter((id): id is string => typeof id === 'string')
      : [];

    if (cardIds.length === 0) {
      return reply.code(400).send({ error: 'Name the cards to merge.', field: 'cardIds' });
    }

    const manager = context.dispatcher.worktreesFor(board.cwd);
    const cards: { cardId: string; title: string; branch: string }[] = [];
    const missing: string[] = [];

    for (const cardId of cardIds) {
      const workspace = manager.workspaceFor(cardId);
      if (workspace === undefined) {
        missing.push(cardId);
        continue;
      }
      cards.push({
        cardId,
        title: getCard(context.database, cardId).title,
        branch: workspace.branch,
      });
    }

    if (cards.length === 0) {
      return reply.code(409).send({
        error: 'None of those cards has a worktree to merge.',
        missing,
      });
    }

    const report = await mergeBranches({
      repoCwd: board.cwd,
      cards,
      ...(typeof request.body?.into === 'string' ? { into: request.body.into } : {}),
      verifyCommand: request.body?.verify ?? null,
    });

    // Merged cards move to the terminal column; the one that broke does not.
    const terminal = context.database.db
      .select()
      .from(columns)
      .where(eq(columns.boardId, board.id))
      .all()
      .find((column) => column.isTerminal);

    for (const step of report.steps) {
      if (step.outcome !== 'merged' || terminal === undefined) continue;
      try {
        moveCard(context.database, step.cardId, terminal.id, 0);
        updateCard(context.database, step.cardId, { status: 'done' });
      } catch {
        // A card that cannot move - usually an unfinished dependency - is
        // still merged. The report is the record; the column is a convenience.
        continue;
      }
    }

    publish(context, 'review-merged', { boardId: board.id, ...report });

    return reply.send({
      ...report,
      missing,
      summary: describeMergeReport(report),
    });
  });

  /** What is waiting to be merged: finished cards that still have a worktree. */
  app.get<{ Params: { boardId: string } }>(
    '/api/boards/:boardId/review/pending',
    async (request, reply) => {
      const board = context.database.db
        .select()
        .from(boards)
        .where(eq(boards.id, request.params.boardId))
        .get();

      if (board === undefined) return reply.code(404).send({ error: 'No such board.' });

      const manager = context.dispatcher.worktreesFor(board.cwd);

      const pending = await Promise.all(
        manager.list().map(async (workspace) => {
          const card = getCard(context.database, workspace.cardId);
          return {
            cardId: card.id,
            title: card.title,
            status: card.status,
            branch: workspace.branch,
            worktree: workspace.path,
            git: await manager.statusOf(card.id),
            verify: context.dispatcher.verifyResultFor(card.id) ?? null,
          };
        }),
      );

      return reply.send(pending.filter((entry) => entry.status !== 'done'));
    },
  );
}

/**
 * The brief (U5, W1).
 *
 * Two sources, one shape. Mechanical entries are derived from the events on
 * every request, because they are free and always current. Model entries were
 * paid for and are read from storage. Both are `StoredEntry`, so nothing below
 * this line knows or cares which is which - apart from the note that says when
 * the second source is missing.
 */
export interface ExtractionState {
  /** False when the board has no extraction model, which the brief must say. */
  readonly configured: boolean;
  readonly tokensSpent: number;
  readonly lastOutcome: string | null;
  /** Present only when the ledger is not the full picture. */
  readonly note: string | null;
}

/** Outcomes that are the pipeline working correctly and need no explanation. */
const QUIET_OUTCOMES: ReadonlySet<string> = new Set(['extracted', 'cached', 'skipped']);

function extractionStateFor(context: AppContext, runIds: readonly string[]): ExtractionState {
  let tokensSpent = 0;
  let lastOutcome: string | null = null;
  let lastNote: string | null = null;

  for (const runId of runIds) {
    const cursor = cursorFor(context.database, runId);
    tokensSpent += cursor.tokensSpent;

    if (cursor.lastOutcome !== null) {
      lastOutcome = cursor.lastOutcome;
      lastNote = cursor.lastNote;
    }
  }

  const configured = context.extraction.configured;

  // The unconfigured case outranks any per-window note: without a model the
  // ledger holds no decisions or assumptions at all, and an operator who thinks
  // "no decisions recorded" means "no decisions were made" is worse off than
  // before (R10).
  const note = !configured
    ? 'Ledger is MECHANICAL ONLY: extraction is switched off, so nothing here records what was decided or assumed. Unset GORILLA_EXTRACTION and restart the board to synthesise through the Claude Code CLI.'
    : lastOutcome !== null && !QUIET_OUTCOMES.has(lastOutcome)
      ? (lastNote ?? `Extraction last ended as ${lastOutcome}.`)
      : null;

  return { configured, tokensSpent, lastOutcome, note };
}

export function registerBriefRoutes(app: FastifyInstance, context: AppContext): void {
  app.get<{ Params: { cardId: string } }>('/api/cards/:cardId/brief', async (request, reply) => {
    try {
      const card = getCard(context.database, request.params.cardId);
      const board = context.database.db
        .select()
        .from(boards)
        .where(eq(boards.id, card.boardId))
        .get();

      const cardRuns = context.database.db
        .select()
        .from(runs)
        .where(eq(runs.cardId, card.id))
        .orderBy(asc(runs.startedAt))
        .all();

      // A stable identity derived from the sources, so "since you last looked"
      // survives the brief being regenerated.
      const entries: StoredEntry[] = [];
      const entryTimes: Record<string, number> = {};
      const changed: string[] = [];

      for (const run of cardRuns) {
        const ledger = buildMechanicalLedger({ sqlite: context.database.sqlite, runId: run.id });

        for (const entry of ledger.entries) {
          const id = `${run.id}:${entry.kind}:${entry.sourceEventIds.join(',')}`;
          entries.push({ ...entry, id, origin: 'mechanical' });

          const first = entry.sourceEventIds[0];
          const at =
            first === undefined
              ? run.startedAt
              : ((
                  context.database.sqlite
                    .prepare('SELECT received_at AS at FROM events WHERE id = ?')
                    .get(first) as { at: number } | undefined
                )?.at ?? run.startedAt);

          entryTimes[id] = at;
        }

        changed.push(...ledger.changed);
      }

      // Model entries: recorded once, when the window that produced them was
      // still readable. Their ids are real rows, so the operator's accept and
      // reject survive; the mechanical ids above are derived and do not.
      entries.push(...storedEntriesFor(context.database, card.id));
      Object.assign(entryTimes, entryTimesFor(context.database, card.id));

      const extraction = extractionStateFor(
        context,
        cardRuns.map((run) => run.id),
      );

      const compactions = (
        context.database.sqlite
          .prepare(
            "SELECT COUNT(*) AS n FROM events WHERE event_name = 'PreCompact' AND run_id IN (SELECT id FROM runs WHERE card_id = ?)",
          )
          .get(card.id) as { n: number }
      ).n;

      const workspacePath =
        board === undefined
          ? undefined
          : context.dispatcher.worktreesFor(board.cwd).pathFor(card.id);

      const reality =
        board === undefined
          ? null
          : await checkReality({
              cwd: workspacePath ?? board.cwd,
              headShaAtStart: cardRuns[0]?.headShaAtStart ?? null,
              claimedPaths: changed,
            });

      const workspace =
        board === undefined
          ? undefined
          : context.dispatcher.worktreesFor(board.cwd).workspaceFor(card.id);

      const brief = buildBrief({
        cardTitle: card.title,
        cardStatus: card.status,
        lastSeenAt: card.lastSeenAt,
        entries,
        entryTimes,
        changedFiles: reality?.changedFiles ?? [],
        changedButUnmentioned: reality?.changedButUnmentioned ?? [],
        verify: context.dispatcher.verifyResultFor(card.id) ?? null,
        goalVerdict: null,
        compactions,
        runCount: cardRuns.length,
        branch: workspace?.branch ?? null,
        extractionNote: extraction.note,
      });

      return reply.send({ ...brief, markdown: renderBrief(brief), extraction });
    } catch (error) {
      return fail(reply, error);
    }
  });

  /** The morning view: every active card, ordered by significance not time. */
  app.get<{ Params: { boardId: string } }>(
    '/api/boards/:boardId/digest',
    async (request, reply) => {
      const cards = listCards(context.database, request.params.boardId);

      const digest = await Promise.all(
        cards
          .filter((card) => card.status !== 'idle')
          .map(async (card) => {
            const response = await app.inject({
              method: 'GET',
              url: `/api/cards/${card.id}/brief`,
            });
            const brief: { headline: string; unseenCount: number } = response.json();

            return {
              cardId: card.id,
              title: card.title,
              status: card.status,
              unseen: brief.unseenCount,
              headline: brief.headline,
              verify: context.dispatcher.verifyResultFor(card.id)?.status ?? null,
            };
          }),
      );

      // A failed verify outranks a quiet completion; unseen outranks seen.
      const rank = (entry: (typeof digest)[number]): number =>
        (entry.verify === 'failed' || entry.verify === 'errored' ? 1000 : 0) +
        (entry.status === 'blocked' ? 500 : 0) +
        entry.unseen;

      return reply.send(digest.sort((a, b) => rank(b) - rank(a)));
    },
  );
}
