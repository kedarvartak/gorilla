import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../app.js';
import { createPlan, getPlan, guardrailNote } from './plans.js';
import { approvePlan, batchStatus, BatchError, mergeBatch } from '../review/batch.js';
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

  /**
   * Approving a plan: one action for the batch.
   *
   * Cuts the integration branch every card in this plan will be merged onto,
   * so the batch is measured against one starting point rather than against
   * whatever the base happened to hold when each card finished.
   */
  app.post<{ Params: { planId: string }; Body: { from?: string } }>(
    '/api/plans/:planId/approve',
    async (request, reply) => {
      try {
        return await approvePlan(context.database, request.params.planId, {
          ...(request.body?.from === undefined ? {} : { from: request.body.from }),
        });
      } catch (error) {
        if (error instanceof BatchError) {
          return reply.code(error.status).send({ error: error.message });
        }
        return fail(reply, error);
      }
    },
  );

  /** What the board says about a batch before anyone opens a card. */
  app.get<{ Params: { planId: string } }>('/api/plans/:planId/status', (request, reply) => {
    try {
      return batchStatus(context.database, request.params.planId);
    } catch (error) {
      if (error instanceof BatchError) {
        return reply.code(error.status).send({ error: error.message });
      }
      return fail(reply, error);
    }
  });

  /**
   * The batch onto the project's own branch.
   *
   * The single approval this design asks for after the plan. Everything
   * before it the board did on its own; this one is a person's.
   */
  app.post<{ Params: { planId: string }; Body: { into?: string } }>(
    '/api/plans/:planId/merge',
    async (request, reply) => {
      try {
        const report = await mergeBatch(context.database, request.params.planId, {
          ...(request.body?.into === undefined ? {} : { into: request.body.into }),
        });
        return reply.code(report.clean ? 200 : 409).send(report);
      } catch (error) {
        if (error instanceof BatchError) {
          return reply.code(error.status).send({ error: error.message });
        }
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
