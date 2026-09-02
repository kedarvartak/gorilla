import { randomUUID } from 'node:crypto';
import { asc, eq, and, isNotNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../app.js';
import { createDefaultColumns } from '../cards/defaults.js';
import { reorderColumns } from '../cards/column-order.js';
import { parseGuardrails } from '../cards/guardrails.js';
import { blockersFor, dispatchableCards, dispatchStanding } from '../cards/eligibility.js';
import { executionOrder } from '../cards/order.js';
import { proposeInvariants } from '../cards/invariant-proposals.js';
import { resync } from '../cards/resync.js';
import { searchCards } from '../cards/search.js';
import { buildPlan, describePlan } from '../cards/plan.js';
import { describeMetrics, readMetrics } from '../metrics.js';
import { isValidHour } from '../dispatch/window.js';
import { describeDuplicates, findDuplicates } from '../cards/duplicates.js';
import { looksFinished } from '../cards/staleness.js';
import { canonicaliseCwd } from '../ingest/binding.js';
import type { AgentProvider } from '../agents/providers.js';
import {
  boards,
  cardDependencies,
  cards as cardsTable,
  columns,
  invariants,
  runs,
  type Card,
} from '../db/schema.js';
import { inferCard } from '../binding/attach.js';
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
import { badRequest, conflict, notFound } from './errors.js';
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
/** Long enough for a median to mean something on a board merging a few a week. */
const DEFAULT_METRICS_DAYS = 30;

const EDITABLE_CARD_FIELDS: ReadonlySet<string> = new Set([
  'title',
  'body',
  'goalCondition',
  'guardrails',
  'agentProvider',
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

    if (board === undefined) return notFound(reply, 'No such board.');

    const budget = request.body?.dailyTokenBudget;
    // Zero is refused rather than read as "no budget": it would stop the
    // queue before it started anything, which reads as a broken board.
    if (
      budget !== undefined &&
      budget !== null &&
      (typeof budget !== 'number' || !Number.isInteger(budget) || budget <= 0)
    ) {
      return badRequest(
        reply,
        'A daily budget must be a positive whole number of tokens, or null for none.',
        'dailyTokenBudget',
      );
    }

    const from = request.body?.dispatchFromHour;
    const to = request.body?.dispatchToHour;

    // Both or neither. One hour on its own describes no window, and storing
    // it would leave a board whose schedule the operator cannot read back.
    if ((from === undefined) !== (to === undefined)) {
      return badRequest(
        reply,
        'A dispatch window needs both hours, or neither.',
        'dispatchFromHour',
      );
    }

    if (from !== undefined && from !== null && !isValidHour(from)) {
      return badRequest(reply, 'An hour must be a whole number from 0 to 23.', 'dispatchFromHour');
    }
    if (to !== undefined && to !== null && !isValidHour(to)) {
      return badRequest(reply, 'An hour must be a whole number from 0 to 23.', 'dispatchToHour');
    }

    const name = request.body?.name;
    if (name !== undefined && (typeof name !== 'string' || name.trim() === '')) {
      return badRequest(reply, 'A board needs a name.', 'name');
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
      return badRequest(reply, 'A board needs a working directory.', 'cwd');
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
      return conflict(reply, 'A board already exists for that directory.', 'cwd');
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

  app.patch<{ Params: { boardId: string }; Body: { order?: unknown } }>(
    '/api/boards/:boardId/columns',
    (request, reply) => {
      const order = request.body.order;

      if (!Array.isArray(order) || order.some((id) => typeof id !== 'string')) {
        return badRequest(reply, 'order must be an array of column ids.');
      }

      const result = reorderColumns(context.database, request.params.boardId, order as string[]);
      if (!result.ok) return badRequest(reply, result.error ?? 'Those columns could not be moved.');

      const moved = context.database.db
        .select()
        .from(columns)
        .where(eq(columns.boardId, request.params.boardId))
        .orderBy(asc(columns.position))
        .all();

      // The board is a live screen and column order is shared structure, so
      // every other window has to be told rather than left showing a pipeline
      // that is no longer the one the dispatcher reads.
      publish('columns-reordered', { boardId: request.params.boardId, columns: moved });
      return reply.send(moved);
    },
  );

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
        return badRequest(reply, 'An invariant needs something to say.', 'statement');
      }

      const existing = context.database.db
        .select()
        .from(invariants)
        .where(eq(invariants.boardId, request.params.boardId))
        .all();

      if (existing.some((rule) => rule.statement === statement)) {
        // Two copies of one rule is the drift this exists to prevent, arriving
        // by a shorter route.
        return conflict(reply, 'That invariant is already on this board.', 'statement');
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

  /**
   * Whether the board is getting anywhere (T59, T60).
   *
   * Thirty days by default, which is long enough for a median to mean
   * something on a board that merges a few cards a week.
   */
  app.get<{ Params: { boardId: string }; Querystring: { days?: string } }>(
    '/api/boards/:boardId/metrics',
    (request) => {
      const requested = Number(request.query.days);
      const window = Number.isFinite(requested) && requested > 0 ? requested : DEFAULT_METRICS_DAYS;
      const since = Date.now() - window * 24 * 60 * 60 * 1_000;

      const metrics = readMetrics(context.database.sqlite, request.params.boardId, since);
      return { ...metrics, notes: describeMetrics(metrics) };
    },
  );

  /**
   * The order the board will work in, and why anything is waiting (T64).
   */
  app.get<{ Params: { boardId: string } }>('/api/boards/:boardId/plan', (request) => {
    const plan = buildPlan(context.database.db, request.params.boardId);
    return { ...plan, note: describePlan(plan) };
  });

  app.get<{ Params: { boardId: string } }>('/api/boards/:boardId/dispatchable', (request) => {
    return dispatchableCards(context.database.db, request.params.boardId);
  });

  // The other half of the same question. The board draws a dispatch control on
  // every idle card and needs to say why the ineligible ones cannot run,
  // rather than omitting the control and leaving the operator to conclude it
  // was removed.
  app.get<{ Params: { boardId: string } }>('/api/boards/:boardId/dispatch-standing', (request) => {
    return dispatchStanding(context.database.db, request.params.boardId);
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
          ...(body['agentProvider'] === undefined
            ? {}
            : { agentProvider: body['agentProvider'] as AgentProvider }),
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
          return badRequest(
            reply,
            `A card has no field called ${unknown.join(', ')}. Editable fields: ${[...EDITABLE_CARD_FIELDS].sort().join(', ')}.`,
            unknown[0],
          );
        }
        const card = updateCard(context.database, request.params.cardId, {
          ...(typeof body['title'] === 'string' ? { title: body['title'] } : {}),
          ...(typeof body['body'] === 'string' ? { body: body['body'] } : {}),
          ...(body['goalCondition'] === undefined
            ? {}
            : { goalCondition: body['goalCondition'] as string | null }),
          ...(body['guardrails'] === undefined ? {} : { guardrails: body['guardrails'] }),
          ...(body['agentProvider'] === undefined
            ? {}
            : { agentProvider: body['agentProvider'] as AgentProvider }),
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

  /**
   * A new card shaped like one that already worked (T49).
   *
   * The backlog asked for templates: a named, curated thing carrying
   * guardrails and a verify command. A separate store of card-shaped objects
   * is a second thing to maintain, and it goes stale in exactly the way the
   * cards do not - because nobody runs a template, so nothing ever proves it
   * still makes sense.
   *
   * The best template on any board is the card that worked last week. So this
   * copies one: its body, its guardrails, its goal and its model choices. What
   * it deliberately does not copy is anything that happened - no runs, no
   * status, no worktree, no merge - because those belong to the card that
   * earned them.
   */
  /**
   * Putting a card away without losing it (T77).
   *
   * A finished board grows forever, and deleting a card takes its runs, its
   * ledger and its judgements with it - the history this product exists to
   * keep. Archiving hides it from the board and the queue and touches nothing
   * else, so a card can come back and its evidence comes back with it.
   */
  app.post<{ Params: { cardId: string }; Body: { archived?: unknown } }>(
    '/api/cards/:cardId/archive',
    (request, reply) => {
      try {
        const card = getCard(context.database, request.params.cardId);
        const archived = request.body?.archived !== false;

        if (archived && card.status === 'running') {
          // Hiding a card mid-run would leave an agent working on something
          // the board no longer shows, which is the state the whole product
          // exists to prevent.
          return conflict(reply, 'That card is running. Cancel it first.', 'archived');
        }

        context.database.db
          .update(cardsTable)
          .set({ archivedAt: archived ? Date.now() : null, updatedAt: Date.now() })
          .where(eq(cardsTable.id, card.id))
          .run();

        const updated = getCard(context.database, card.id);
        publish(archived ? 'card-archived' : 'card-unarchived', present(updated));

        return reply.send(present(updated));
      } catch (error) {
        return fail(reply, error);
      }
    },
  );

  /** The cards put away, so they can be found again. */
  app.get<{ Params: { boardId: string } }>('/api/boards/:boardId/archived', (request) => {
    return context.database.db
      .select()
      .from(cardsTable)
      .where(and(eq(cardsTable.boardId, request.params.boardId), isNotNull(cardsTable.archivedAt)))
      .orderBy(asc(cardsTable.archivedAt))
      .all()
      .map((card) => present(card));
  });

  app.post<{ Params: { cardId: string }; Body: { title?: unknown } }>(
    '/api/cards/:cardId/clone',
    (request, reply) => {
      try {
        const source = getCard(context.database, request.params.cardId);
        const title =
          typeof request.body?.title === 'string' && request.body.title.trim() !== ''
            ? request.body.title.trim()
            : `Copy of ${source.title}`;

        const card = createCard(context.database, {
          boardId: source.boardId,
          title,
          body: source.body,
          guardrails: parseGuardrails(source.guardrails),
          goalCondition: source.goalCondition,
          agentModel: source.agentModel,
          agentEffort: source.agentEffort,
          synthesisModel: source.synthesisModel,
          priority: source.priority,
        });

        publish('card-created', present(card));
        return reply.code(201).send(present(card));
      } catch (error) {
        return fail(reply, error);
      }
    },
  );

  /**
   * Splitting a card too large to dispatch (T52).
   *
   * A card an agent cannot finish in one run is not a card, it is a project,
   * and the failure it produces is expensive: a run that spends its budget
   * getting a third of the way and leaves a branch nobody wants.
   *
   * The parts depend on the original, not on each other. That is the
   * conservative reading: the operator said this work divides, not that it
   * sequences, and inventing an order between them would serialise work that
   * could have run in parallel. They can add an order themselves.
   */
  app.post<{ Params: { cardId: string }; Body: { titles?: unknown } }>(
    '/api/cards/:cardId/split',
    (request, reply) => {
      const titles = request.body?.titles;

      if (!Array.isArray(titles) || titles.length < 2) {
        return badRequest(
          reply,
          'Splitting a card needs at least two titles. One is a rename, not a split.',
          'titles',
        );
      }

      const cleaned = titles
        .filter((title): title is string => typeof title === 'string')
        .map((title) => title.trim())
        .filter((title) => title !== '');

      if (cleaned.length !== titles.length) {
        return badRequest(reply, 'Every part needs a title.', 'titles');
      }

      try {
        const source = getCard(context.database, request.params.cardId);

        const parts = cleaned.map((title) => {
          const part = createCard(context.database, {
            boardId: source.boardId,
            title,
            body: [
              `Split from "${source.title}".`,
              '',
              // The original's body is carried rather than divided. Dividing it
              // would mean guessing which half of a description belongs to
              // which part, and guessing wrong on the operator's behalf.
              source.body.trim() === '' ? '' : source.body.trim(),
            ]
              .join('\n')
              .trim(),
            guardrails: parseGuardrails(source.guardrails),
            goalCondition: source.goalCondition,
            agentModel: source.agentModel,
            agentEffort: source.agentEffort,
            priority: source.priority,
          });

          addDependency(context.database, part.id, source.id);
          publish('card-created', present(part));
          return present(part);
        });

        // The original stays. It is the thing the parts depend on and the place
        // the history lives; deleting it would orphan every run it already has.
        return reply.code(201).send({ source: present(source), parts });
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
          return badRequest(reply, 'A move needs a target column.', 'columnId');
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

  /**
   * Turns an unclaimed session into a card, when the operator asks.
   *
   * The board used to do this by itself on every terminal session, which put
   * the operator's own planning conversations in Intake as work the queue
   * could never take (#160). Nothing was lost by stopping - the run holds its
   * events either way - but the door has to stay open: a session that turned
   * out to matter should be adoptable without going through the database.
   *
   * A title may be given, because "Unclaimed session 3f2a1b" is honest and
   * useless, and the operator adopting it knows what it was.
   */
  /**
   * Catches the board up with work done outside it.
   *
   * A separate button rather than part of the board read, because it costs a
   * `git log` and the board is polled. The cheap half of this signal already
   * runs on every read; this is the half that needs asking for.
   *
   * `?dry=1` reports without moving anything, which is what the tests use and
   * what an operator who does not trust it yet should reach for.
   */
  app.post<{
    Params: { boardId: string };
    Querystring: { dry?: string };
    Body: { cardId?: unknown } | undefined;
  }>('/api/boards/:boardId/resync', async (request, reply) => {
    try {
      const board = context.database.db
        .select()
        .from(boards)
        .where(eq(boards.id, request.params.boardId))
        .get();
      if (board === undefined) return notFound(reply, 'No such board.');

      // A card id narrows the sweep to one card, which is how the card page
      // asks the same question about the card already open.
      const cardId = typeof request.body?.cardId === 'string' ? request.body.cardId : null;

      const report = await resync(context.database, board.id, board.cwd, context.resyncJudge, {
        apply: request.query.dry !== '1',
        cardId,
      });

      // Only when something actually moved. A stream event per press would
      // redraw every open board for a result that was "nothing changed".
      if (report.findings.some((finding) => finding.movedTo !== null)) {
        publish('cards-resynced', report);
      }

      return reply.send(report);
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.post<{ Params: { runId: string }; Body: { title?: unknown } }>(
    '/api/runs/:runId/adopt',
    (request, reply) => {
      try {
        const title = request.body?.title;
        if (title !== undefined && typeof title !== 'string') {
          return fail(reply, new CardError('title must be a string.', 400, 'title'));
        }

        const card = inferCard(context.database, request.params.runId, title ?? null);
        publish('card-created', present(card));
        return reply.code(201).send(present(card));
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
          return badRequest(reply, 'Name the card depended on.', 'dependsOn');
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
