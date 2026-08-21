import type { FastifyReply } from 'fastify';
import type { AppContext } from '../app.js';
import { describeGuardrails, parseGuardrails } from '../cards/guardrails.js';
import { type Card } from '../db/schema.js';
import { CardError, PRIORITIES, isPriority, type CardPriority } from './cards.js';

/**
 * Helpers every route module needs.
 *
 * They live here rather than in one of the route files because the first
 * module to need a second copy is the moment the two copies start to differ,
 * and `present` in particular decides what an interface is allowed to believe
 * about a guardrail.
 */
export function fail(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof CardError) {
    return reply.code(error.status).send({
      error: error.message,
      ...(error.field === undefined ? {} : { field: error.field }),
    });
  }
  throw error;
}

/** Guardrails are stored as JSON; the interface wants them parsed and described. */
export function publish(context: AppContext, event: string, data: unknown): void {
  context.broadcaster.publish(event, data);
}

/**
 * Refuses an unknown priority rather than storing it.
 *
 * The chip reorders the dispatch queue, so a value the ordering does not
 * recognise would silently sort as low - a card the operator marked urgent
 * running last, with nothing to explain why.
 */
export function readPriority(value: unknown): CardPriority {
  if (!isPriority(value)) {
    throw new CardError(`Priority must be one of ${PRIORITIES.join(', ')}.`, 400, 'priority');
  }
  return value;
}

export function present(card: Card): Record<string, unknown> {
  const guardrails = parseGuardrails(card.guardrails);
  return {
    ...card,
    guardrails,
    // Sent alongside so the interface cannot accidentally present an advisory
    // rule as though it were enforced (R10).
    guardrailDetail: describeGuardrails(guardrails),
  };
}
