import { randomUUID } from 'node:crypto';

import { asc, eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply } from 'fastify';

import type { AppContext } from '../app.js';
import { createDefaultColumns } from '../cards/defaults.js';
import { describeGuardrails, parseGuardrails } from '../cards/guardrails.js';
import { blockersFor, dispatchableCards } from '../cards/eligibility.js';
import { canonicaliseCwd } from '../ingest/binding.js';
import { boards, cardDependencies, columns, type Card } from '../db/schema.js';
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

  app.post<{ Params: { boardId: string }; Body: { mode?: string; concurrency?: number } }>(
    '/api/boards/:boardId/dispatch',
    (request, reply) => {
      const { boardId } = request.params;
      const mode = request.body?.mode;
      const concurrency = request.body?.concurrency;

      if (mode !== undefined && mode !== 'manual' && mode !== 'automatic') {
        return reply.code(400).send({ error: 'Mode must be manual or automatic.', field: 'mode' });
      }
      if (concurrency !== undefined && (!Number.isInteger(concurrency) || concurrency < 1)) {
        return reply
          .code(400)
          .send({ error: 'Concurrency must be a positive integer.', field: 'concurrency' });
      }

      if (concurrency !== undefined) context.dispatcher.setConcurrency(boardId, concurrency);
      if (mode !== undefined) context.dispatcher.setMode(boardId, mode);

      return reply.send(context.dispatcher.state(boardId));
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
