import { describe, expect, it } from 'vitest';

import {
  densityOf,
  describeDensity,
  totalsOf,
  type TimedEvent,
} from '../src/server/timeline/density.js';

/**
 * Where a run's time went (T32).
 *
 * A timeline of two hundred evenly spaced events says a run happened and
 * nothing about its shape. When a card took four hours the question is which
 * part took four hours, and the answer is almost always one tool call or one
 * long silence - which the list renders identically.
 */

function at(event: string, seconds: number): TimedEvent {
  return { event, receivedAt: seconds * 1_000 };
}

describe('classifying the gaps', () => {
  it('calls the inside of a tool call a tool', () => {
    const density = densityOf([at('PreToolUse', 0), at('PostToolUse', 30)]);

    expect(density[1]).toEqual({ sinceMs: 30_000, interval: 'tool' });
  });

  it('calls the gap after a tool answers something else', () => {
    const density = densityOf([at('PreToolUse', 0), at('PostToolUse', 1), at('PreToolUse', 20)]);

    // Not "thinking". It covers thinking, waiting on the API and being rate
    // limited, and the board cannot tell those apart - naming one would be
    // asserting it.
    expect(density[2]?.interval).toBe('between');
  });

  it('has nothing to say about the first event', () => {
    expect(densityOf([at('SessionStart', 0)])[0]).toEqual({ sinceMs: 0, interval: 'start' });
  });

  it('stays inside a tool call that never answered', () => {
    const density = densityOf([at('PreToolUse', 0), at('Notification', 10), at('Stop', 20)]);

    // The honest reading: the board saw a tool asked for and never saw it
    // answer, so it does not know when it stopped.
    expect(density[1]?.interval).toBe('tool');
    expect(density[2]?.interval).toBe('tool');
  });

  it('treats a failed tool as an answer', () => {
    const density = densityOf([at('PreToolUse', 0), at('PostToolUseFailure', 5), at('Stop', 30)]);

    expect(density[2]?.interval).toBe('between');
  });

  it('never reports a negative gap', () => {
    // Events arrive over HTTP and two can be recorded out of order. A negative
    // duration in a total is worse than a zero.
    expect(densityOf([at('Stop', 10), at('Stop', 5)])[1]?.sinceMs).toBe(0);
  });
});

describe('adding it up', () => {
  it('separates time in tools from time between them', () => {
    const totals = totalsOf(
      densityOf([at('PreToolUse', 0), at('PostToolUse', 10), at('PreToolUse', 40)]),
    );

    expect(totals.toolMs).toBe(10_000);
    expect(totals.betweenMs).toBe(30_000);
  });

  it('names the longest single gap and what it was', () => {
    const totals = totalsOf(
      densityOf([at('PreToolUse', 0), at('PostToolUse', 300), at('PreToolUse', 305)]),
    );

    // Totals are what a chart would show. The single longest interval is what
    // actually explains a four-hour card.
    expect(totals.longestMs).toBe(300_000);
    expect(totals.longestInterval).toBe('tool');
  });
});

describe('saying it', () => {
  it('leads with the longest gap', () => {
    const note = describeDensity(
      totalsOf(densityOf([at('PreToolUse', 0), at('PostToolUse', 600)])),
    );

    expect(note).toContain('longest single gap');
    expect(note).toContain('inside one tool call');
  });

  it('declines rather than reporting zero for a run with one event', () => {
    // "0ms in tools" reads as a measurement of a run that did nothing.
    expect(describeDensity(totalsOf(densityOf([at('SessionStart', 0)])))).toContain(
      'Too few events',
    );
  });
});
