import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../app.js';
import { boards } from '../db/schema.js';
import { apiError, badRequest, conflict, notFound } from './errors.js';
import { fail } from './shared.js';
import { fileDiff } from '../worktree/diff.js';
import { describeOrphans, findOrphans } from '../worktree/orphans.js';
import { describeVerify } from '../verify/run.js';
import { getCard } from './cards.js';
import { describeSpend, spentSince, startOfDay } from '../dispatch/budget.js';

/**
 * Dispatch control (P8).
 *
 * Separate from the card routes because dispatching is an action on the board,
 * not an edit to a card, and the operator reasons about it that way.
 */
export function registerDispatchRoutes(app: FastifyInstance, context: AppContext): void {
  app.get<{ Params: { boardId: string } }>('/api/boards/:boardId/dispatch', (request) => {
    const { boardId } = request.params;
    const board = context.database.db.select().from(boards).where(eq(boards.id, boardId)).get();
    const budget = board?.dailyTokenBudget ?? null;
    const spend = spentSince(context.database.sqlite, boardId, startOfDay(Date.now()));

    // Sent whether or not a budget is set. What the board spent today is worth
    // seeing on its own, and it is the only way an operator can pick a budget
    // that is neither pointless nor immediately hit.
    return {
      ...context.dispatcher.state(boardId),
      budget,
      spend,
      spendNote: describeSpend(spend, budget),
    };
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
      return badRequest(reply, 'Mode must be manual or automatic.', 'mode');
    }
    if (policy !== undefined && policy !== 'review' && policy !== 'unattended') {
      return badRequest(reply, 'Policy must be review or unattended.', 'policy');
    }
    if (concurrency !== undefined && (!Number.isInteger(concurrency) || concurrency < 1)) {
      return badRequest(reply, 'Concurrency must be a positive integer.', 'concurrency');
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

      if (board === undefined) return notFound(reply, 'No such board.');

      const manager = context.dispatcher.worktreesFor(board.cwd);
      const orphans = findOrphans(context.database.sqlite, manager.list());
      const orphanBy = new Map(orphans.map((orphan) => [orphan.cardId, orphan.reason]));

      const workspaces = await Promise.all(
        manager.list().map(async (workspace) => ({
          ...workspace,
          status: await manager.statusOf(workspace.cardId),
          // Why nothing is waiting on it, or null. Named rather than implied,
          // because a merged card's leftover and a deleted card's orphan are
          // different decisions for the operator (T48).
          orphanReason: orphanBy.get(workspace.cardId) ?? null,
        })),
      );

      return reply.send({ workspaces, orphans, orphanNote: describeOrphans(orphans) });
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

      if (board === undefined) return notFound(reply, 'No such board.');

      // Removal is an operator action. A worktree holds a night of an agent's
      // work and is never cleaned up automatically (doc 18).
      const result = await context.dispatcher
        .worktreesFor(board.cwd)
        .remove(request.params.cardId, { force: request.query.force === 'true' });

      return result.ok ? reply.send({ removed: true }) : conflict(reply, result.reason);
    },
  );

  /**
   * One file's diff (T31).
   *
   * One at a time: the whole diff of a real card is megabytes, and an operator
   * reads it a file at a time anyway. Served as text, because a diff wrapped
   * in JSON is a diff nobody can pipe anywhere.
   */
  app.get<{ Params: { cardId: string }; Querystring: { path?: string } }>(
    '/api/cards/:cardId/diff',
    async (request, reply) => {
      const path = request.query.path;
      if (path === undefined || path.trim() === '') {
        return badRequest(reply, 'Name the file to diff.', 'path');
      }

      const card = getCard(context.database, request.params.cardId);
      const board = context.database.db
        .select()
        .from(boards)
        .where(eq(boards.id, card.boardId))
        .get();

      if (board === undefined) return notFound(reply, 'No such board.');

      const workspace = context.dispatcher.worktreesFor(board.cwd).workspaceFor(card.id);
      const diff = await fileDiff(board.cwd, workspace?.branch ?? null, path);

      // Null means the branch could not be read, which for a merged card is
      // the ordinary case rather than an error worth a 500.
      if (diff === null) {
        return notFound(
          reply,
          'That branch could not be read. A merged card has usually had its branch removed.',
        );
      }

      return reply.type('text/plain; charset=utf-8').send(diff);
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
            ...apiError('conflict', 'The card could not be dispatched.'),
            // The dispatcher's own state travels with the refusal, because the
            // reason it declined is in there and nowhere else.
            state: context.dispatcher.state(request.params.boardId),
          });
        }

        return reply.code(202).send(context.dispatcher.state(request.params.boardId));
      } catch (error) {
        return fail(reply, error);
      }
    },
  );

  /**
   * Sends a blocked card back to the queue, with what the operator says about
   * it (T21, T22).
   *
   * Distinct from dispatching it again: the worktree is kept, so the next run
   * continues in the checkout the last one left rather than starting over.
   */
  /**
   * Runs a card's verify command now (T57).
   *
   * Runs where the card's work is - its worktree - rather than in the board's
   * checkout, so the answer is about the branch under review rather than about
   * whatever the operator happens to have checked out.
   */
  app.post<{ Params: { boardId: string; cardId: string } }>(
    '/api/boards/:boardId/cards/:cardId/verify',
    async (request, reply) => {
      const result = await context.dispatcher.verifyNow(
        request.params.boardId,
        request.params.cardId,
      );

      // Null means the card has no verify command. Not a failure, and not a
      // pass either: reporting it as either would be the board asserting
      // something nobody checked.
      return result === null
        ? reply.send({ ran: false, note: 'This card has no verify command.' })
        : reply.send({ ran: true, result, note: describeVerify(result) });
    },
  );

  app.post<{ Params: { boardId: string; cardId: string }; Body: { note?: unknown } }>(
    '/api/boards/:boardId/cards/:cardId/retry',
    (request, reply) => {
      const note = request.body?.note;
      if (note !== undefined && note !== null && typeof note !== 'string') {
        return badRequest(reply, 'A retry note must be text.', 'note');
      }

      const retried = context.dispatcher.retry(
        request.params.boardId,
        request.params.cardId,
        note ?? null,
      );

      // Refused rather than queued while it runs. Two runs in one worktree
      // overwrite each other, and the damage surfaces at merge time.
      return retried
        ? reply.code(202).send(context.dispatcher.state(request.params.boardId))
        : conflict(reply, 'That card is still running.');
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
