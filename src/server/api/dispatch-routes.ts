import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../app.js';
import { boards } from '../db/schema.js';
import { fail } from './shared.js';

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
