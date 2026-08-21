import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../app.js';
import { createPlan, getPlan, guardrailNote } from './plans.js';
import { fail, present, publish } from './shared.js';

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
