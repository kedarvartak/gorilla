import { describe, expect, it } from 'vitest';

import {
  classifyLaunchFailure,
  decideRetry,
  DEFAULT_MAX_ATTEMPTS,
} from '../src/server/dispatch/retry.js';
import type { LaunchResult } from '../src/server/launcher/launcher.js';

/**
 * Whether a failure is worth trying again (T42).
 *
 * The rule is one-sided on purpose: retry only where there is positive
 * evidence the cause was transient. A missed retry costs one card. A wrong
 * retry reruns every card whose tests genuinely fail, twice, every night.
 */

function failed(stderr: string, exitCode = 1): LaunchResult {
  return {
    outcome: 'failed',
    exitCode,
    signal: null,
    sessionId: 's',
    events: [],
    retries: 0,
    stderr,
  };
}

describe('classifying a failure', () => {
  it('calls an overloaded API transient', () => {
    expect(classifyLaunchFailure(failed('API Error: 529 overloaded_error')).kind).toBe('transient');
  });

  it('calls a rate limit transient', () => {
    expect(classifyLaunchFailure(failed('429 Too Many Requests: rate limit exceeded')).kind).toBe(
      'transient',
    );
  });

  it('calls a dropped connection transient', () => {
    expect(classifyLaunchFailure(failed('read ECONNRESET')).kind).toBe('transient');
    expect(classifyLaunchFailure(failed('getaddrinfo EAI_AGAIN api.anthropic.com')).kind).toBe(
      'transient',
    );
  });

  it('calls an ordinary non-zero exit stated', () => {
    // The run finished normally and reported that it did not succeed. Running
    // it again does not change that, and the CLI exits 1 for both this and an
    // overloaded API - which is why the stderr is what gets read.
    expect(classifyLaunchFailure(failed('Task could not be completed.')).kind).toBe('stated');
  });

  it('calls a supervisor failure transient', () => {
    // Nothing is known about what the run did or whether it would fail again.
    expect(classifyLaunchFailure(null).kind).toBe('transient');
  });

  it('does not read the word overloaded out of ordinary output', () => {
    // A guard against the marker matching the agent's own prose rather than an
    // error: stderr is the CLI's channel, so a task about load balancing does
    // not land here.
    expect(classifyLaunchFailure(failed('')).kind).toBe('stated');
  });
});

describe('deciding whether to retry', () => {
  const transient = { kind: 'transient' as const, why: 'the API was overloaded' };
  const stated = { kind: 'stated' as const, why: 'the session exited with code 1' };

  it('retries a transient failure on the first attempt', () => {
    expect(decideRetry(transient, 1).retry).toBe(true);
  });

  it('never retries a stated failure, however few attempts were made', () => {
    expect(decideRetry(stated, 0).retry).toBe(false);
    expect(decideRetry(stated, 0).why).toContain('Not retried');
  });

  it('stops once the attempts are used up', () => {
    expect(decideRetry(transient, DEFAULT_MAX_ATTEMPTS).retry).toBe(false);
  });

  it('says the attempts are exhausted, not that the API was overloaded', () => {
    const why = decideRetry(transient, DEFAULT_MAX_ATTEMPTS).why;

    // A card that says 'overloaded' after its last attempt reads as still
    // worth retrying, which is the opposite of what happened.
    expect(why).toContain('attempts have been made');
  });

  it('says which attempt is being made', () => {
    // A retry the operator cannot count is one they cannot tell from a loop.
    expect(decideRetry(transient, 1).why).toContain('Attempt 2 of 2');
  });
});
