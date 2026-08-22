import { randomUUID } from 'node:crypto';
import { asc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../app.js';
import { createDefaultColumns } from '../cards/defaults.js';
import { parseGuardrails } from '../cards/guardrails.js';
import { blockersFor, dispatchableCards } from '../cards/eligibility.js';
import { executionOrder } from '../cards/order.js';
import { proposeInvariants } from '../cards/invariant-proposals.js';
import { searchCards } from '../cards/search.js';
import { isValidHour } from '../dispatch/window.js';
import { describeDuplicates, findDuplicates } from '../cards/duplicates.js';
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

/**
 * What a card update may set (T4).
 *
 * Listed rather than derived from the type, because the type is erased at
 * runtime and a list that drifts from the handler is caught by the tests that
 * exercise each field. Adding a field here without handling it below is the
 * one mistake this cannot catch, which is why the set sits directly above the
 * handler that reads it.
 */
const EDITABLE_CARD_FIELDS: ReadonlySet<string> = new Set([
  'title',
  'body',
  'goalCondition',
  'guardrails',
  'agentModel',
  'agentEffort',
  'synthesisModel',
  'permissionMode',
  'priority',
  'status',
  'tokenCeiling',
]);

export function registerApiRoutes(app: FastifyInstance, context: AppContext): void {
  const publish = (event: string, data: unknown): void => {
    context.broadcaster.publish(event, data);
  };

  app.get('/api/boards', () => {
    return context.database.db.select().from(boards).orderBy(asc(boards.createdAt)).all();
  });

  /**
   * Board settings. Only the budget for now (T27).
   *
   * `cwd` is deliberately not editable: it is what routes incoming hook events
   * to this board, and changing it would silently orphan every session already
   * running against the old path.
   */
  app.patch<{
    Params: { boardId: string };
    Body: {
      dailyTokenBudget?: unknown;
      name?: unknown;
      dispatchFromHour?: unknown;
      dispatchToHour?: unknown;
    };
  }>('/api/boards/:boardId', (request, reply) => {
    const board = context.database.db
      .select()
      .from(boards)
      .where(eq(boards.id, request.params.boardId))
      .get();

    if (board === undefined) return reply.code(404).send({ error: 'No such board.' });

    const budget = request.body?.dailyTokenBudget;
    // Zero is refused rather than read as "no budget": it would stop the
    // queue before it started anything, which reads as a broken board.
    if (
      budget !== undefined &&
      budget !== null &&
      (typeof budget !== 'number' || !Number.isInteger(budget) || budget <= 0)
    ) {
      return reply.code(400).send({
        error: 'A daily budget must be a positive whole number of tokens, or null for none.',
        field: 'dailyTokenBudget',
      });
    }

    const from = request.body?.dispatchFromHour;
    const to = request.body?.dispatchToHour;

    // Both or neither. One hour on its own describes no window, and storing
    // it would leave a board whose schedule the operator cannot read back.
    if ((from === undefined) !== (to === undefined)) {
      return reply.code(400).send({
        error: 'A dispatch window needs both hours, or neither.',
        field: 'dispatchFromHour',
      });
    }

    if (from !== undefined && from !== null && !isValidHour(from)) {
      return reply
        .code(400)
        .send({ error: 'An hour must be a whole number from 0 to 23.', field: 'dispatchFromHour' });
    }
    if (to !== undefined && to !== null && !isValidHour(to)) {
      return reply
        .code(400)
        .send({ error: 'An hour must be a whole number from 0 to 23.', field: 'dispatchToHour' });
    }

    const name = request.body?.name;
    if (name !== undefined && (typeof name !== 'string' || name.trim() === '')) {
      return reply.code(400).send({ error: 'A board needs a name.', field: 'name' });
    }

    context.database.db
      .update(boards)
      .set({
        ...(budget === undefined ? {} : { dailyTokenBudget: budget }),
        ...(from === undefined ? {} : { dispatchFromHour: from }),
        ...(to === undefined ? {} : { dispatchToHour: to }),
        ...(name === undefined ? {} : { name: name.trim() }),
      })
      .where(eq(boards.id, board.id))
      .run();

    const updated = context.database.db.select().from(boards).where(eq(boards.id, board.id)).get();

    publish('board-updated', updated);
    return reply.send(updated);
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

  /**
   * Card rules that have become project rules (T15).
   *
   * Proposals, like the guardrail shortlist. Writing a project rule from three
   * cards' worth of evidence is still the operator's call: an invariant
   * reaches every future card, and one the board invented would constrain work
   * nobody agreed to constrain.
   */
  app.get<{ Params: { boardId: string } }>(
    '/api/boards/:boardId/invariant-proposals',
    (request) => {
      return proposeInvariants(context.database.sqlite, request.params.boardId);
    },
  );

  /**
   * Finding a card again (T34).
   *
   * Searches the paths a card touched as well as its words: the card that
   * edited a file is usually the card being looked for, and its title may not
   * mention the file at all.
   */
  app.get<{ Params: { boardId: string }; Querystring: { q?: string } }>(
    '/api/boards/:boardId/search',
    (request) => {
      return searchCards(context.database.sqlite, request.params.boardId, request.query.q ?? '');
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

        // Checked after creation, not before it (T53). A warning, never a
        // refusal: two cards that read alike are sometimes two genuinely
        // different pieces of work, and a board that refused the second is one
        // the operator learns to word their titles around.
        const duplicates = findDuplicates(
          context.database.sqlite,
          request.params.boardId,
          card.title,
          card.id,
        );

        return reply.code(201).send({
          ...present(card),
          duplicates,
          duplicateNote: describeDuplicates(duplicates),
        });
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

        // Refused rather than ignored (T4). An update that accepts a field it
        // does not know reports success for a change it did not make, and the
        // operator finds out when the card behaves as though they never edited
        // it - which is indistinguishable from the edit not having saved.
        const unknown = Object.keys(body).filter((key) => !EDITABLE_CARD_FIELDS.has(key));
        if (unknown.length > 0) {
          return reply.code(400).send({
            error: `A card has no field called ${unknown.join(', ')}. Editable fields: ${[...EDITABLE_CARD_FIELDS].sort().join(', ')}.`,
            field: unknown[0],
          });
        }
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
