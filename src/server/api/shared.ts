import type { FastifyReply } from 'fastify';
import type { AppContext } from '../app.js';
import type { ApiErrorCode } from './errors.js';
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
/**
 * The one refusal path that does not start in a handler: it begins as a thrown
 * `CardError`. It ends in the same shape as the rest (T8) - the status the
 * error chose, plus a code derived from it - so nothing downstream has to know
 * which of the two paths a refusal arrived by.
 */
export function fail(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof CardError) {
    return reply.code(error.status).send({
      error: error.message,
      code: codeForStatus(error.status),
      ...(error.field === undefined ? {} : { field: error.field }),
    });
  }
  throw error;
}

function codeForStatus(status: number): ApiErrorCode {
  if (status === 404) return 'not-found';
  if (status === 409) return 'conflict';
  return 'invalid-field';
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
