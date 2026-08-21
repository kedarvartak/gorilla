import { randomUUID } from 'node:crypto';
import { asc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../app.js';
import { createDefaultColumns } from '../cards/defaults.js';
import { parseGuardrails } from '../cards/guardrails.js';
import { blockersFor, dispatchableCards } from '../cards/eligibility.js';
import { executionOrder } from '../cards/order.js';
import { looksFinished } from '../cards/staleness.js';
import { canonicaliseCwd } from '../ingest/binding.js';
import { boards, cardDependencies, columns, invariants, runs, type Card } from '../db/schema.js';
import {
  addDependency,
  createCard,
  deleteCard,
  getCard,
  listCards,
  markSeen,
  moveCard,
  removeDependency,
  updateCard,
} from './cards.js';
import { fail, present, readPriority } from './shared.js';

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
          // Passed through unchecked on purpose: updateCard refuses a ceiling
          // that is not a positive whole number, and one validator saying no is
          // better than two that can drift apart.
          ...(body['tokenCeiling'] === undefined
            ? {}
            : { tokenCeiling: body['tokenCeiling'] as number | null }),
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
