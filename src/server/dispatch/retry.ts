import type { LaunchResult } from '../launcher/launcher.js';

/**
 * Whether a failure is worth trying again (T42).
 *
 * The escalation ladder decides what a failure does to the queue. This decides
 * whether it was a failure at all, or a network having a bad minute.
 *
 * The rule is deliberately one-sided: retry only where there is positive
 * evidence the cause was transient. The alternative - retry unless something
 * proves otherwise - reruns a card whose tests genuinely fail, twice, and
 * charges for it. A missed retry costs one card; a wrong retry costs every
 * card that fails for a real reason, every night.
 */

export type FailureKind = 'transient' | 'stated';

export interface FailureVerdict {
  readonly kind: FailureKind;
  /** Said in the card's own terms, because it appears in the halt the operator reads. */
  readonly why: string;
}

/**
 * Two attempts, not five.
 *
 * A transient fault that survives one retry is not transient any more, and the
 * difference between finding that out at attempt two and at attempt five is
 * three runs' worth of tokens.
 */
export const DEFAULT_MAX_ATTEMPTS = 2;

/**
 * Markers of a fault outside the card's control.
 *
 * Matched against the CLI's stderr rather than against an exit code, because
 * the CLI exits 1 for an overloaded API and for a task it could not do, and
 * treating those the same is what makes a retry policy dangerous.
 */
const TRANSIENT_MARKERS: readonly RegExp[] = [
  // No trailing word boundary: the API's own name for this is
  // `overloaded_error`, and an underscore is a word character, so `\b` would
  // fail to match the exact string this pattern exists to catch.
  /overloaded/i,
  /rate.?limit/i,
  // Named statuses rather than a 5xx range, so a number in ordinary output
  // cannot be read as an outage.
  /\b(429|500|502|503|504|529)\b/,
  /ECONNRESET/,
  /ETIMEDOUT/,
  /ENOTFOUND/,
  /EAI_AGAIN/,
  /socket hang up/i,
  /network (error|failure)/i,
];

export function classifyLaunchFailure(result: LaunchResult | null): FailureVerdict {
  // Null is the supervisor failing, not the agent: the process could not be
  // watched, so nothing is known about what it did or whether it would fail
  // again. That is as transient as this gets.
  if (result === null) {
    return { kind: 'transient', why: 'the session could not be supervised' };
  }

  const marker = TRANSIENT_MARKERS.find((pattern) => pattern.test(result.stderr));
  if (marker !== undefined) {
    return { kind: 'transient', why: 'the run hit a fault outside the card: ' + describe(marker) };
  }

  // A run that finished normally and exited non-zero did the work and reported
  // that it did not succeed. Running it again does not change that.
  return { kind: 'stated', why: `the session exited with code ${String(result.exitCode)}` };
}

function describe(pattern: RegExp): string {
  return pattern.source
    .replace(/\\b|\(|\)|\?|\.\*|\\d/g, '')
    .replace(/\|/g, ' or ')
    .trim();
}

export interface RetryDecision {
  readonly retry: boolean;
  readonly why: string;
}

/**
 * Combines the verdict with what this card has already been through.
 *
 * Attempts are counted on the card rather than in memory: a board that
 * restarts mid-batch would otherwise forget, and a card that fails on every
 * start would be retried forever by a supervisor that keeps restarting it.
 */
export function decideRetry(
  verdict: FailureVerdict,
  attempts: number,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
): RetryDecision {
  if (verdict.kind === 'stated') {
    return { retry: false, why: `Not retried: ${verdict.why}.` };
  }

  if (attempts >= maxAttempts) {
    return {
      retry: false,
      // Named as exhausted rather than as the original fault. A card that says
      // 'overloaded' after three attempts reads as still worth retrying.
      why: `Not retried again: ${String(attempts)} attempts have been made, the last failing because ${verdict.why}.`,
    };
  }

  return {
    retry: true,
    why: `Retrying: ${verdict.why}. Attempt ${String(attempts + 1)} of ${String(maxAttempts)}.`,
  };
}
