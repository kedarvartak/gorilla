import type { FastifyReply } from 'fastify';

/**
 * One shape for every refusal (T8).
 *
 * Thirty-seven handlers each assembled their own `{ error, field }`, which
 * means the interface has one way to find out what went wrong: read the
 * message. Prose is the wrong thing to branch on - it is written for a person,
 * it gets reworded, and a client that matches on it breaks silently when
 * somebody improves a sentence.
 *
 * So every refusal now carries a code as well. The message stays, because the
 * operator reads that; the code is what anything else should switch on.
 */

export type ApiErrorCode =
  /** A field was missing, malformed, or not one this route accepts. */
  | 'invalid-field'
  | 'not-found'
  /** The request was understood and the state says no. */
  | 'conflict'
  /** A gate declined. Not a failure: the gate working, with something to do. */
  | 'refused';

export interface ApiError {
  readonly error: string;
  readonly code: ApiErrorCode;
  /** Present when the refusal is about one field, so the interface can point at it. */
  readonly field?: string;
}

const STATUS: Record<ApiErrorCode, number> = {
  'invalid-field': 400,
  'not-found': 404,
  conflict: 409,
  refused: 409,
};

export function apiError(code: ApiErrorCode, error: string, field?: string): ApiError {
  return { error, code, ...(field === undefined ? {} : { field }) };
}

export function sendError(
  reply: FastifyReply,
  code: ApiErrorCode,
  error: string,
  field?: string,
): FastifyReply {
  return reply.code(STATUS[code]).send(apiError(code, error, field));
}

/** The three that account for nearly all of them, named for how they read. */
export function badRequest(reply: FastifyReply, error: string, field?: string): FastifyReply {
  return sendError(reply, 'invalid-field', error, field);
}

export function notFound(reply: FastifyReply, error: string): FastifyReply {
  return sendError(reply, 'not-found', error);
}

export function conflict(reply: FastifyReply, error: string, field?: string): FastifyReply {
  return sendError(reply, 'conflict', error, field);
}
