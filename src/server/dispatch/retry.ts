import type { LaunchResult, StreamEventPayload } from '../launcher/launcher.js';

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

export type FailureKind = 'transient' | 'quota' | 'stated';

export interface FailureVerdict {
  readonly kind: FailureKind;
  /** Said in the card's own terms, because it appears in the halt the operator reads. */
  readonly why: string;
  /**
   * When the provider says the quota resets, in epoch ms. Only for `quota`,
   * and only when the stream said so.
   */
  readonly resetsAt?: number;
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

/**
 * A usage or rate limit that will not clear by trying again now.
 *
 * Claude Code reports these inside the JSON stream, not on stderr: an
 * assistant message carrying `error: "rate_limit"` and a `result` with
 * `is_error`, the text saying the 5-hour limit was hit. Case study 1 had four
 * cards fail that way and the classifier, reading stderr only, called each an
 * ordinary failure and halted the queue on the streak.
 */
const QUOTA_MARKERS: readonly RegExp[] = [
  /usage_limit_reached/i,
  /rate_limit/i,
  /out_of_credits/i,
  /hit your [\w -]{0,20}limit/i,
  /"apiErrorStatus":\s*429\b/,
];

/**
 * Events that report an error rather than describe work.
 *
 * Only these are searched. The rest of the stream is the agent's own output,
 * where "429" or "rate limit" is as likely to be the subject of the card as a
 * fault in running it.
 */
function errorEvents(events: readonly StreamEventPayload[]): StreamEventPayload[] {
  return events.filter(
    (event) =>
      event.is_error === true ||
      event.isApiErrorMessage === true ||
      (event['error'] !== undefined && event['error'] !== null) ||
      event.type === 'rate_limit_event' ||
      (event.type === 'system' && event.subtype === 'api_retry'),
  );
}

/** A reset time in epoch ms from anything shaped like `resetsAt`, if present. */
function resetsAtIn(events: readonly StreamEventPayload[]): number | undefined {
  for (const event of events) {
    const match = /"resets_?[aA]t"\s*:\s*(\d{9,13})/.exec(JSON.stringify(event));
    if (match?.[1] === undefined) continue;
    const raw = Number(match[1]);
    // Seconds from the API; milliseconds if someone already converted it.
    return raw < 1e12 ? raw * 1000 : raw;
  }
  return undefined;
}

export function classifyLaunchFailure(result: LaunchResult | null): FailureVerdict {
  // Null is the supervisor failing, not the agent: the process could not be
  // watched, so nothing is known about what it did or whether it would fail
  // again. That is as transient as this gets.
  if (result === null) {
    return { kind: 'transient', why: 'the session could not be supervised' };
  }

  const errors = errorEvents(result.events ?? []);
  const quotaEvents = errors.filter((event) => {
    if (event.type === 'system' && event.subtype === 'api_retry') return false;
    if (event.type === 'rate_limit_event') {
      // Informational unless the request was actually refused.
      return /"status"\s*:\s*"rejected"/.test(JSON.stringify(event));
    }
    const text = JSON.stringify(event);
    return QUOTA_MARKERS.some((pattern) => pattern.test(text));
  });
  const quotaInStderr = /usage_limit_reached|out_of_credits|hit your [\w -]{0,20}limit/i.test(
    result.stderr,
  );

  if (quotaEvents.length > 0 || quotaInStderr) {
    const resetsAt = resetsAtIn(quotaEvents.length > 0 ? quotaEvents : errors);
    return {
      kind: 'quota',
      why:
        'the provider refused the request on a usage limit' +
        (resetsAt === undefined ? '' : `, which resets at ${new Date(resetsAt).toISOString()}`),
      ...(resetsAt === undefined ? {} : { resetsAt }),
    };
  }

  const streamErrors = errors.map((event) => JSON.stringify(event)).join('\n');
  const marker = TRANSIENT_MARKERS.find(
    (pattern) => pattern.test(result.stderr) || pattern.test(streamErrors),
  );
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

  // Not now, and not counted against the card: retrying before the reset
  // spends nothing and proves nothing. The dispatcher holds the queue instead.
  if (verdict.kind === 'quota') {
    return { retry: false, why: `Held, not retried: ${verdict.why}.` };
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
