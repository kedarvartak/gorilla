import { describe, expect, it } from 'vitest';

import { assessStall, DEFAULT_STALL, type RunProgress } from '../src/server/dispatch/stall.js';

/**
 * Written after a real failure: a dispatched card spent twenty-five hours
 * issuing the same blocked command once an hour, 63 times, while the board
 * reported it as running and the queue waited behind it.
 */

const NOW = 1_700_000_000_000;
const started = (agoMs: number): number => NOW - agoMs;

function progress(over: Partial<RunProgress> = {}): RunProgress {
  return {
    intents: 0,
    outcomes: 0,
    lastEventAt: NOW - 1_000,
    startedAt: started(10 * 60 * 1000),
    ...over,
  };
}

describe('a denial storm', () => {
  it('is what a permission wall looks like from outside', () => {
    // The exact shape of the failure: many intents, not one outcome.
    const verdict = assessStall(progress({ intents: 40, outcomes: 0 }), NOW);

    expect(verdict.stalled).toBe(true);
    expect(verdict.kind).toBe('denial-storm');
    expect(verdict.detail).toContain('not one completed');
    expect(verdict.detail).toContain('permission mode');
  });

  it('is not raised while tools are completing', () => {
    // A run doing real work has unresolved calls in flight all the time.
    expect(assessStall(progress({ intents: 40, outcomes: 30 }), NOW).stalled).toBe(false);
  });

  it('is not raised for a handful of refusals', () => {
    expect(assessStall(progress({ intents: 3, outcomes: 0 }), NOW).stalled).toBe(false);
  });

  it('holds off during the grace period', () => {
    // Cancelling a session that has only just started would be impatience, not
    // detection.
    const young = progress({ intents: 40, outcomes: 0, startedAt: started(10_000) });
    expect(assessStall(young, NOW).stalled).toBe(false);
  });
});

describe('silence', () => {
  it('is a stall once nothing has arrived for long enough', () => {
    const quiet = progress({
      intents: 2,
      outcomes: 2,
      lastEventAt: NOW - DEFAULT_STALL.maxSilenceMs - 1_000,
      startedAt: started(60 * 60 * 1000),
    });

    const verdict = assessStall(quiet, NOW);
    expect(verdict.stalled).toBe(true);
    expect(verdict.kind).toBe('silent');
    expect(verdict.detail).toContain('minute(s)');
  });

  it('is measured from the start when no event ever arrived', () => {
    const nothing = progress({
      lastEventAt: null,
      startedAt: started(DEFAULT_STALL.maxSilenceMs + 1_000),
    });
    expect(assessStall(nothing, NOW).kind).toBe('silent');
  });

  it('is not raised while events keep arriving', () => {
    expect(assessStall(progress({ lastEventAt: NOW - 5_000 }), NOW).stalled).toBe(false);
  });
});

describe('the thresholds', () => {
  it('sit well beyond anything a healthy run produces', () => {
    // A false positive cancels work in progress, so both are deliberately
    // conservative. The failure this catches produced a hundred.
    expect(DEFAULT_STALL.maxUnresolved).toBeGreaterThanOrEqual(10);
    expect(DEFAULT_STALL.maxSilenceMs).toBeGreaterThanOrEqual(10 * 60 * 1000);
    expect(DEFAULT_STALL.graceMs).toBeGreaterThan(0);
  });
});
