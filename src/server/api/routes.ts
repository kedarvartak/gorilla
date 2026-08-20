import { randomUUID } from 'node:crypto';

import { asc, eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply } from 'fastify';

import type { AppContext } from '../app.js';
import { createDefaultColumns } from '../cards/defaults.js';
import { describeGuardrails, parseGuardrails } from '../cards/guardrails.js';
import { blockersFor, dispatchableCards } from '../cards/eligibility.js';
import { executionOrder } from '../cards/order.js';
import { assessStaleness, looksFinished, mergedPaths } from '../cards/staleness.js';
import { canonicaliseCwd } from '../ingest/binding.js';
import {
  boards,
  cardDependencies,
  cards as cardsTable,
  columns,
  invariants,
  ledgerEntries,
  runs,
  type Card,
} from '../db/schema.js';
import {
  addDependency,
  CardError,
  createCard,
  deleteCard,
  getCard,
  listCards,
  markSeen,
  moveCard,
  PRIORITIES,
  removeDependency,
  updateCard,
  isPriority,
  type CardPriority,
} from './cards.js';
import { createPlan, getPlan, guardrailNote } from './plans.js';
import { claim, claimableCards, mergeCard } from '../binding/attach.js';
import { buildMechanicalLedger } from '../ledger/mechanical.js';
import { checkReality, describeReality } from '../ledger/reality.js';
import { describeVerify } from '../verify/run.js';
import { buildBrief, renderBrief, type Brief } from '../brief/brief.js';
import { briefToMarkdown, exportFilename } from '../brief/markdown.js';
import type { StoredEntry } from '../ledger/dedupe.js';
import {
  cursorFor,
  entryTimesFor,
  setOperatorStatus,
  markPromoted,
  storedEntriesFor,
  storedEntryById,
} from '../ledger/store.js';
import { isOperatorStatus, OPERATOR_STATUSES } from '../ledger/entries.js';
import { promoteToGuardrail, PromotionError } from '../ledger/promote.js';
import { surprisesFor, type Surprise } from '../ledger/surprises.js';
import {
  acknowledgedPaths,
  GATE_REACH,
  mergeGate,
  PATH_ACK_PREFIX,
  type GateCard,
} from '../review/gate.js';
import { describeMergeReport, mergeBranches, mergeTargetFor } from '../review/merge.js';
import { isMerging, resolveConflicts } from '../review/resolve.js';

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

/**
 * Refuses an unknown priority rather than storing it.
 *
 * The chip reorders the dispatch queue, so a value the ordering does not
 * recognise would silently sort as low - a card the operator marked urgent
 * running last, with nothing to explain why.
 */
function readPriority(value: unknown): CardPriority {
  if (!isPriority(value)) {
    throw new CardError(`Priority must be one of ${PRIORITIES.join(', ')}.`, 400, 'priority');
  }
  return value;
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
    // Ranked here rather than in the interface: the order has to agree with what
    // the dispatcher does next, and two implementations of that rule would drift.
    const order = new Map(
      executionOrder(context.database.db, request.params.boardId).map((entry) => [
        entry.cardId,
        entry,
      ]),
    );

    const board = context.database.db
      .select()
      .from(boards)
      .where(eq(boards.id, request.params.boardId))
      .get();

    // One query for every card's run count rather than one per card: the board
    // lists everything at once, and this endpoint is on every page load.
    const runCounts = new Map(
      context.database.db
        .select({ cardId: runs.cardId })
        .from(runs)
        .all()
        .reduce((counts, row) => {
          if (row.cardId !== null) counts.set(row.cardId, (counts.get(row.cardId) ?? 0) + 1);
          return counts;
        }, new Map<string, number>()),
    );

    return listCards(context.database, request.params.boardId).map((card) => {
      const ranked = order.get(card.id);

      return {
        ...present(card),
        rank: ranked?.rank ?? null,
        rankBlocked: ranked?.blocked ?? false,
        // The cheap signal only. The card's own view does the full comparison
        // against merged work, which costs a git call per merged card.
        looksFinished:
          board !== undefined &&
          card.mergedAt === null &&
          card.status !== 'done' &&
          card.status !== 'abandoned' &&
          looksFinished({
            body: card.body,
            guardrails: parseGuardrails(card.guardrails),
            runCount: runCounts.get(card.id) ?? 0,
            repoCwd: board.cwd,
          }),
      };
    });
  });

  /**
   * Rules true of the project rather than of one card (doc 12, output 2).
   *
   * Repeating a standing rule on every card is how it drifts: a rule stated five
   * ways is one nobody can rely on. These are stated once and reach every
   * dispatched card, marked as project rules so the agent can tell them from the
   * card's own peculiarities.
   */
  app.get<{ Params: { boardId: string } }>('/api/boards/:boardId/invariants', (request) => {
    return context.database.db
      .select()
      .from(invariants)
      .where(eq(invariants.boardId, request.params.boardId))
      .orderBy(asc(invariants.createdAt))
      .all();
  });

  app.post<{ Params: { boardId: string }; Body: { statement?: unknown; sourceCardId?: unknown } }>(
    '/api/boards/:boardId/invariants',
    (request, reply) => {
      const statement =
        typeof request.body?.statement === 'string' ? request.body.statement.trim() : '';

      if (statement === '') {
        return reply
          .code(400)
          .send({ error: 'An invariant needs something to say.', field: 'statement' });
      }

      const existing = context.database.db
        .select()
        .from(invariants)
        .where(eq(invariants.boardId, request.params.boardId))
        .all();

      if (existing.some((rule) => rule.statement === statement)) {
        // Two copies of one rule is the drift this exists to prevent, arriving
        // by a shorter route.
        return reply
          .code(409)
          .send({ error: 'That invariant is already on this board.', field: 'statement' });
      }

      const id = randomUUID();
      context.database.db
        .insert(invariants)
        .values({
          id,
          boardId: request.params.boardId,
          statement,
          sourceCardId:
            typeof request.body?.sourceCardId === 'string' ? request.body.sourceCardId : null,
          createdAt: Date.now(),
        })
        .run();

      const created = context.database.db
        .select()
        .from(invariants)
        .where(eq(invariants.id, id))
        .get();

      publish('invariants-changed', { boardId: request.params.boardId });
      return reply.code(201).send(created);
    },
  );

  app.delete<{ Params: { boardId: string; invariantId: string } }>(
    '/api/boards/:boardId/invariants/:invariantId',
    (request, reply) => {
      context.database.db
        .delete(invariants)
        .where(eq(invariants.id, request.params.invariantId))
        .run();

      publish('invariants-changed', { boardId: request.params.boardId });
      return reply.code(204).send();
    },
  );

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
          // Reaches `--effort`. It was in the schema and passed to the launcher
          // but accepted by no route, so the column could never be set.
          ...(body['agentEffort'] === undefined
            ? {}
            : { agentEffort: body['agentEffort'] as string | null }),
          ...(body['priority'] === undefined ? {} : { priority: readPriority(body['priority']) }),
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
          ...(body['agentEffort'] === undefined
            ? {}
            : { agentEffort: body['agentEffort'] as string | null }),
          ...(body['priority'] === undefined ? {} : { priority: readPriority(body['priority']) }),
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
    async (request, reply) => {
      try {
        // `dispatchIsolated`, not `dispatch`: the latter runs in the board's own
        // checkout. It had no callers at all, so every card started from the
        // interface was writing into the operator's working tree on whatever
        // branch they were on - the precise collision U2 exists to prevent.
        const running = await context.dispatcher.dispatchIsolated(
          request.params.boardId,
          request.params.cardId,
        );

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
        // Distinguishes "the session told us it ended" from "we deduced it must
        // have". The interface must not present a deduction as a report.
        endReason: run.endReason,
        goalOutcome: run.goalOutcome,
        mode: run.mode,
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

      // Whether the card still describes work that needs doing. Read here
      // rather than on the board, because it costs a git call per merged card
      // and the board lists everything at once.
      const board2 = context.database.db
        .select()
        .from(boards)
        .where(eq(boards.id, card.boardId))
        .get();

      const mergedCards = context.database.db
        .select()
        .from(cardsTable)
        .where(eq(cardsTable.boardId, card.boardId))
        .all()
        .filter((other) => other.id !== card.id && other.mergedAt !== null);

      const staleness =
        board2 === undefined
          ? null
          : assessStaleness({
              cardTitle: card.title,
              body: card.body,
              guardrails,
              runCount: cardRuns.length,
              repoCwd: board2.cwd,
              merged: await Promise.all(
                mergedCards.map(async (other) => ({
                  title: other.title,
                  verify: parseGuardrails(other.guardrails).verify,
                  paths: await mergedPaths(board2.cwd, other.mergedBranch),
                })),
              ),
            });

      const verify = context.dispatcher.verifyResultFor(card.id);

      // The isolated branch this card's work is sitting on, unmerged. Without
      // this the interface can describe what happened but offers no way to act
      // on it, which is where "how do I close this?" comes from.
      const manager = board === undefined ? null : context.dispatcher.worktreesFor(board.cwd);
      const workspace = manager?.workspaceFor(card.id);

      return reply.send({
        card: present(card),
        guardrails,
        guardrailDetail: describeGuardrails(guardrails),
        workspace:
          workspace === undefined
            ? null
            : {
                branch: workspace.branch,
                worktree: workspace.path,
                git: await manager?.statusOf(card.id),
              },
        mergeTarget: board === undefined ? null : await mergeTargetFor(board.cwd),
        verifyCommand: guardrails.verify ?? null,
        // What the board checked, rather than what the agent claimed.
        verify: verify ?? null,
        verifyNote: verify === undefined ? null : describeVerify(verify),
        blockers: blockersFor(context.database.db, card.id),
        staleness,
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
    const cards: { cardId: string; title: string; branch: string; worktree?: string }[] = [];
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
        // Passed so the reviewer can refuse a merge whose work is still sitting
        // uncommitted in the worktree, which once produced a card reading
        // "merged and verified" with nothing on the branch at all.
        worktree: workspace.path,
      });
    }

    if (cards.length === 0) {
      return reply.code(409).send({
        error: 'None of those cards has a worktree to merge.',
        missing,
      });
    }

    // The gate (P3). Read before anything is merged, and applied to the whole
    // request: one card with an unjudged surprise holds the batch, because a
    // partially applied merge is the state the reviewer exists to avoid.
    const gateCards: GateCard[] = [];

    for (const card of cards) {
      const response = await app.inject({ method: 'GET', url: `/api/cards/${card.cardId}/brief` });

      if (response.statusCode !== 200) {
        // Cannot tell means do not merge. Treating an unreadable brief as
        // "nothing outstanding" would make the gate silently absent exactly
        // when the card is in a state nobody has looked at.
        return reply.code(409).send({
          error: `Nothing was merged: the brief for "${card.title}" could not be read, so the board cannot tell whether anything on it is outstanding.`,
          reach: GATE_REACH,
          blocked: [],
          outstanding: 0,
          mergedNothing: true,
        });
      }

      const brief = response.json<{ surprises?: readonly Surprise[] }>();
      gateCards.push({ ...card, surprises: brief.surprises ?? [] });
    }

    const refusal = mergeGate(gateCards);
    if (refusal !== null) return reply.code(409).send(refusal);

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

    const mergedAt = Date.now();

    for (const step of report.steps) {
      if (step.outcome !== 'merged') continue;

      // Recorded before the move, and independently of it. A card that cannot
      // change column - usually an unfinished dependency - has still been
      // merged, and losing that fact would leave it reading as merely `done`.
      context.database.db
        .update(cardsTable)
        .set({
          mergedAt,
          mergedInto: report.into,
          mergedBranch: step.branch,
          updatedAt: mergedAt,
        })
        .where(eq(cardsTable.id, step.cardId))
        .run();

      if (terminal === undefined) continue;

      try {
        moveCard(context.database, step.cardId, terminal.id, 0);
        updateCard(context.database, step.cardId, { status: 'done' });
      } catch {
        // The report is the record; the column is a convenience.
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

  /**
   * Resolving the conflict the board is sitting in.
   *
   * A conflict is the ordinary cost of two agents working in parallel, so
   * stopping there made the one merge action fail on exactly the mornings it was
   * most needed. The board resolves it instead, then judges the result from the
   * repository rather than from what the resolver claims.
   */
  app.post<{
    Params: { boardId: string };
    Body: { branch?: string; into?: string; verify?: string | null };
  }>('/api/boards/:boardId/review/resolve', async (request, reply) => {
    const board = context.database.db
      .select()
      .from(boards)
      .where(eq(boards.id, request.params.boardId))
      .get();

    if (board === undefined) return reply.code(404).send({ error: 'No such board.' });

    if (!isMerging(board.cwd)) {
      return reply.code(409).send({
        error: 'This repository is not part way through a merge, so there is nothing to resolve.',
      });
    }

    const result = await resolveConflicts({
      repoCwd: board.cwd,
      branch: request.body?.branch ?? 'the card branch',
      into: request.body?.into ?? (await mergeTargetFor(board.cwd)) ?? 'HEAD',
      verifyCommand: request.body?.verify ?? null,
    });

    publish(context, 'review-resolved', { boardId: board.id, ...result });

    // 409 for anything short of resolved: the caller asked for a merge to be
    // completed, and a report that it was not is not a success.
    return reply.code(result.outcome === 'resolved' ? 200 : 409).send(result);
  });

  /**
   * Promoting a judged entry into a rule (doc 12, output 1).
   *
   * The step that makes judgement compound. Without it an accepted assumption
   * reaches the next run as context and evaporates; as a guardrail it constrains.
   */
  app.post<{
    Params: { entryId: string };
    Body: { target?: unknown; rule?: unknown };
  }>('/api/ledger/:entryId/promote', (request, reply) => {
    const { entryId } = request.params;
    const target = request.body?.target;

    if (target !== 'scope' && target !== 'prohibit' && target !== 'verify') {
      return reply
        .code(400)
        .send({ error: 'Promote to scope, prohibit or verify.', field: 'target' });
    }

    const entry = storedEntryById(context.database, entryId);
    if (entry === undefined) {
      return reply.code(404).send({ error: `No such ledger entry: ${entryId}` });
    }

    const owner = context.database.db
      .select()
      .from(ledgerEntries)
      .where(eq(ledgerEntries.id, entryId))
      .get();

    if (owner === undefined) return reply.code(404).send({ error: 'No such ledger entry.' });

    try {
      const card = getCard(context.database, owner.cardId);
      const rule = typeof request.body?.rule === 'string' ? request.body.rule : '';

      const result = promoteToGuardrail(parseGuardrails(card.guardrails), {
        entry,
        target,
        rule,
      });

      const updated = updateCard(context.database, card.id, { guardrails: result.guardrails });
      markPromoted(context.database, entryId, rule.trim());

      publish(context, 'card-updated', present(updated));

      // The enforcement kind travels with the answer. An operator shown an
      // enforced rule when the board could only manage prompt text has been
      // told a protection exists that does not (R10).
      return reply.send({
        card: present(updated),
        enforcement: result.enforcement,
        detail: result.detail,
      });
    } catch (error) {
      if (error instanceof PromotionError) {
        return reply.code(400).send({ error: error.message, field: error.field });
      }
      return fail(reply, error);
    }
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
  /**
   * The operator's verdict on one entry (doc 12, P2).
   *
   * `setOperatorStatus` has existed since the ledger was written and had no
   * caller at all, so the board asserted things at the operator with no way to
   * say "that is wrong". A synthesised claim nobody can correct is worse than
   * one nobody made: it teaches the operator to stop reading.
   *
   * Nothing is deleted. A rejection is evidence about the model, and doc 12's
   * repair path reads only from these verdicts.
   */
  app.post<{ Params: { entryId: string }; Body: { status?: unknown; statement?: unknown } }>(
    '/api/ledger/:entryId/status',
    (request, reply) => {
      const { entryId } = request.params;
      const status = request.body?.status;

      if (!isOperatorStatus(status)) {
        return reply.code(400).send({
          error: `Status must be one of ${OPERATOR_STATUSES.join(', ')}.`,
          field: 'status',
        });
      }

      const existing = storedEntryById(context.database, entryId);
      if (existing === undefined) {
        return reply.code(404).send({ error: `No such ledger entry: ${entryId}` });
      }

      const statement = request.body?.statement;

      if (status === 'corrected' && typeof statement !== 'string') {
        // Correcting without saying what it should be would leave the entry
        // marked as fixed and still wrong, which is worse than leaving it.
        return reply.code(400).send({
          error: 'A corrected entry needs the statement it should read instead.',
          field: 'statement',
        });
      }

      setOperatorStatus(
        context.database,
        entryId,
        status,
        typeof statement === 'string' ? statement : undefined,
      );

      const updated = storedEntryById(context.database, entryId);
      publish(context, 'ledger-judged', { entryId, status });

      return reply.send(updated);
    },
  );

  /**
   * The operator's verdict on a changed-but-unmentioned path (P3).
   *
   * Without this, a path surprise could be shown and never retired, and the
   * merge gate would hold such a card for good - a refusal with no way through
   * is not a gate, it is a wall. The acknowledgement is stored as a judged
   * ledger entry because the path has no row of its own.
   */
  app.post<{ Params: { cardId: string }; Body: { path?: unknown; status?: unknown } }>(
    '/api/cards/:cardId/surprises/path',
    (request, reply) => {
      const { cardId } = request.params;
      const path = request.body?.path;

      if (typeof path !== 'string' || path.trim() === '') {
        return reply.code(400).send({ error: 'Name the path you looked at.', field: 'path' });
      }

      const status = request.body?.status ?? 'accepted';
      if (!isOperatorStatus(status) || status === 'unreviewed') {
        return reply.code(400).send({
          error: `Status must be one of ${OPERATOR_STATUSES.filter((value) => value !== 'unreviewed').join(', ')}.`,
          field: 'status',
        });
      }

      try {
        getCard(context.database, cardId);
      } catch (error) {
        return fail(reply, error);
      }

      // The entry hangs off a run because that is what the table requires. A
      // card with no run has had no agent near it, so nothing has been recorded
      // to look at either.
      const run = context.database.db
        .select()
        .from(runs)
        .where(eq(runs.cardId, cardId))
        .orderBy(asc(runs.startedAt))
        .all()
        .at(-1);

      if (run === undefined) {
        return reply.code(409).send({
          error: 'This card has no run, so there is nothing recorded to acknowledge against.',
        });
      }

      const id = randomUUID();
      context.database.db
        .insert(ledgerEntries)
        .values({
          id,
          cardId,
          runId: run.id,
          kind: 'change',
          statement: `${PATH_ACK_PREFIX}${path}`,
          filePaths: JSON.stringify([path]),
          sourceEventIds: '[]',
          origin: 'mechanical',
          operatorStatus: status,
          createdAt: Date.now(),
        })
        .run();

      publish(context, 'surprise-acknowledged', { cardId, path, status });
      return reply.code(201).send({ id, cardId, path, status });
    },
  );

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
        merged:
          card.mergedAt === null || card.mergedInto === null || card.mergedBranch === null
            ? null
            : { at: card.mergedAt, into: card.mergedInto, branch: card.mergedBranch },
        extractionNote: extraction.note,
      });

      // The set the operator would regret not reading, carried alongside the
      // brief so the interface never has to work out what is outstanding.
      const seen = acknowledgedPaths(entries);
      const surprises = surprisesFor({
        cardId: card.id,
        entries,
        // A path stays changed-but-unmentioned however long the operator looks
        // at it, so the acknowledgement is applied here rather than pretending
        // the run mentioned it.
        changedButUnmentioned: (reality?.changedButUnmentioned ?? []).filter(
          (path) => !seen.has(path),
        ),
      });

      return reply.send({ ...brief, markdown: renderBrief(brief), extraction, surprises });
    } catch (error) {
      return fail(reply, error);
    }
  });

  /**
   * The brief as a file (doc 08, export).
   *
   * Built by asking the brief route rather than rebuilding it here. Two paths
   * that computed a brief separately would eventually disagree, and the export
   * is precisely the copy that gets pasted somewhere the board cannot correct
   * it later.
   */
  app.get<{ Params: { cardId: string } }>('/api/cards/:cardId/brief.md', async (request, reply) => {
    try {
      const card = getCard(context.database, request.params.cardId);
      const board = context.database.db
        .select()
        .from(boards)
        .where(eq(boards.id, card.boardId))
        .get();

      const response = await app.inject({
        method: 'GET',
        url: `/api/cards/${card.id}/brief`,
      });

      if (response.statusCode !== 200) {
        return reply.code(response.statusCode).send(response.json());
      }

      const markdown = briefToMarkdown({
        brief: response.json<Brief>(),
        cardId: card.id,
        boardName: board?.name ?? 'unknown board',
        generatedAt: Date.now(),
      });

      // Sent as a file rather than as JSON holding a string: the operator asked
      // for something to keep, and a filename they can find again among thirty
      // downloads is part of that.
      return reply
        .header('content-type', 'text/markdown; charset=utf-8')
        .header(
          'content-disposition',
          `attachment; filename="${exportFilename(card.title, card.id)}"`,
        )
        .send(markdown);
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
