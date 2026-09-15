import { eq } from 'drizzle-orm';

import type { DatabaseHandle } from '../db/client.js';
import { boards, type Board } from '../db/schema.js';

/**
 * The project's execution policy (doc 12, and the one-click execution work).
 *
 * The decision this settles is who owns a card's configuration. It used to be
 * the operator, per card: provider, model, effort, the verify command and the
 * turn bound were all typed again on every card, which made readying a task a
 * configuration exercise before it was a piece of work. Worse, it made them
 * drift - twenty cards carrying twenty copies of one decision, differing in
 * ways nobody chose.
 *
 * So the project owns them and a card inherits. The inheritance is a **stamp**
 * rather than a lookup: the values are written onto the card when it is
 * created, so the card records literally what it will run with. A run from
 * last month can be reproduced, and "this card ran on opus" is a fact on the
 * card rather than an answer that changes when the policy does. The price,
 * chosen deliberately, is that editing the policy does not reach cards that
 * already exist - which is why `describePolicy` exists to say what the policy
 * will apply to the next card, and why the board offers to restamp rather than
 * doing it silently.
 */

export interface ExecutionPolicy {
  readonly provider: 'claude' | 'codex';
  /** Null means the provider's own default, which is not a value we chose. */
  readonly model: string | null;
  readonly effort: string | null;
  readonly permissionMode: string | null;
  /** What the board runs to check a card. The board runs it, not the agent. */
  readonly verify: string | null;
  /** What a fresh worktree needs before an agent can work in it. */
  readonly setup: string | null;
  readonly tokenCeiling: number | null;
}

export const DEFAULT_POLICY: ExecutionPolicy = {
  provider: 'claude',
  model: null,
  effort: null,
  permissionMode: null,
  verify: null,
  setup: null,
  tokenCeiling: null,
};

export function policyOf(board: Board): ExecutionPolicy {
  return {
    provider: board.policyProvider,
    model: board.policyModel,
    effort: board.policyEffort,
    permissionMode: board.policyPermissionMode,
    verify: board.policyVerify,
    setup: board.policySetup,
    tokenCeiling: board.policyTokenCeiling,
  };
}

/** The policy for a board, or the defaults when the board is unknown. */
export function readPolicy(handle: DatabaseHandle, boardId: string): ExecutionPolicy {
  const board = handle.db.select().from(boards).where(eq(boards.id, boardId)).get();
  return board === undefined ? DEFAULT_POLICY : policyOf(board);
}

export class PolicyError extends Error {
  constructor(
    message: string,
    readonly field: string,
  ) {
    super(message);
    this.name = 'PolicyError';
  }
}

function asText(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw new PolicyError(`${field} must be text.`, field);
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Reads a policy off a request body, refusing what it cannot honour.
 *
 * Refusing rather than coercing. A ceiling of zero read as "no ceiling" is a
 * board that silently stops enforcing the thing the operator just asked it to
 * enforce, and a provider name with a typo in it would otherwise be stored and
 * only fail at dispatch, hours later, on a card that looked configured.
 */
export function parsePolicy(input: Record<string, unknown>): ExecutionPolicy {
  const provider = input.provider === undefined ? 'claude' : input.provider;
  if (provider !== 'claude' && provider !== 'codex') {
    throw new PolicyError('The provider must be either claude or codex.', 'provider');
  }

  let tokenCeiling: number | null = null;
  if (input.tokenCeiling !== null && input.tokenCeiling !== undefined) {
    const value = Number(input.tokenCeiling);
    if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
      throw new PolicyError(
        'A token ceiling is a whole number of tokens above zero. Leave it empty for no ceiling.',
        'tokenCeiling',
      );
    }
    tokenCeiling = value;
  }

  return {
    provider,
    model: asText(input.model, 'model'),
    effort: asText(input.effort, 'effort'),
    permissionMode: asText(input.permissionMode, 'permissionMode'),
    verify: asText(input.verify, 'verify'),
    setup: asText(input.setup, 'setup'),
    tokenCeiling,
  };
}

export function writePolicy(
  handle: DatabaseHandle,
  boardId: string,
  policy: ExecutionPolicy,
): ExecutionPolicy {
  const updated = handle.db
    .update(boards)
    .set({
      policyProvider: policy.provider,
      policyModel: policy.model,
      policyEffort: policy.effort,
      policyPermissionMode: policy.permissionMode,
      policyVerify: policy.verify,
      policySetup: policy.setup,
      policyTokenCeiling: policy.tokenCeiling,
    })
    .where(eq(boards.id, boardId))
    .returning()
    .get();

  if (updated === undefined) throw new PolicyError(`No such board: ${boardId}`, 'boardId');
  return policyOf(updated);
}

/** What a card takes from the policy unless it says otherwise. */
export interface StampedExecution {
  readonly agentProvider: 'claude' | 'codex';
  readonly agentModel: string | null;
  readonly agentEffort: string | null;
  readonly permissionMode: string | null;
  readonly tokenCeiling: number | null;
}

/**
 * The stamp itself.
 *
 * What the caller asked for wins, always. A plan that says opus for one card
 * means that card runs on opus whatever the project's usual model is, and a
 * policy that overrode an explicit request would be a setting that quietly
 * discards what the operator typed.
 */
/**
 * What the caller stated, where "stated nothing" has to be distinguishable
 * from "stated null". Written with explicit `undefined` rather than as
 * `Partial`, because `exactOptionalPropertyTypes` makes those different types
 * and the callers pass the absent case through as a value.
 */
export interface AskedExecution {
  readonly agentProvider?: 'claude' | 'codex' | undefined;
  readonly agentModel?: string | null | undefined;
  readonly agentEffort?: string | null | undefined;
  readonly permissionMode?: string | null | undefined;
  readonly tokenCeiling?: number | null | undefined;
}

export function stamp(policy: ExecutionPolicy, asked: AskedExecution = {}): StampedExecution {
  return {
    agentProvider: asked.agentProvider ?? policy.provider,
    agentModel: asked.agentModel ?? policy.model,
    agentEffort: asked.agentEffort ?? policy.effort,
    permissionMode: asked.permissionMode ?? policy.permissionMode,
    tokenCeiling: asked.tokenCeiling ?? policy.tokenCeiling,
  };
}

/**
 * The policy's verify command, applied to a card that named none.
 *
 * Separate from `stamp` because a guardrail set is a structure rather than a
 * column, and because a card with an empty verify is the common case the
 * policy exists to answer: the project knows how it is tested, and saying so
 * on every card is how that knowledge goes stale.
 */
export function stampVerify(policy: ExecutionPolicy, verify: string | null): string | null {
  return verify ?? policy.verify;
}
