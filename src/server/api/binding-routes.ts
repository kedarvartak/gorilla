import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../app.js';
import { claim, claimableCards, mergeCard } from '../binding/attach.js';
import { fail, present, publish } from './shared.js';

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
