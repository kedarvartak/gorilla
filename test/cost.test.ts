import { describe, expect, it } from 'vitest';

import { accumulateCost, describeCost, totalTokens, NO_COST } from '../src/server/launcher/cost.js';
import type { StreamEventPayload } from '../src/server/launcher/launcher.js';

/**
 * What a run cost (T29).
 *
 * The board spends money unattended and recorded none of it. A ceiling cannot
 * be enforced against a figure nobody keeps, so these tests are as much about
 * the two readings staying distinguishable as about the arithmetic.
 */

function assistant(input: number, output: number): StreamEventPayload {
  return {
    type: 'assistant',
    message: { usage: { input_tokens: input, output_tokens: output } },
  };
}

describe('reading a run’s cost', () => {
  it('prefers the CLI’s own total', () => {
    const cost = accumulateCost([
      assistant(100, 20),
      {
        type: 'result',
        subtype: 'success',
        total_cost_usd: 0.42,
        num_turns: 3,
        duration_ms: 8_000,
        usage: {
          input_tokens: 500,
          output_tokens: 120,
          cache_read_input_tokens: 9_000,
          cache_creation_input_tokens: 1_000,
        },
      },
    ]);

    // Not 600: the result event is the CLI's accounting of the whole run, so
    // adding the message on top of it would bill the same turn twice.
    expect(cost.inputTokens).toBe(500);
    expect(cost.costUsd).toBe(0.42);
    expect(cost.turns).toBe(3);
    expect(cost.source).toBe('result');
    expect(totalTokens(cost)).toBe(10_620);
  });

  it('adds up the messages when no result event carries usage', () => {
    const cost = accumulateCost([assistant(100, 20), assistant(50, 10)]);

    expect(cost.inputTokens).toBe(150);
    expect(cost.outputTokens).toBe(30);
    expect(cost.turns).toBe(2);
    expect(cost.source).toBe('messages');
    // No price. What a token costs is not something the board knows, and a
    // figure it invented would be indistinguishable from one it was told.
    expect(cost.costUsd).toBeNull();
  });

  it('reports nothing rather than zero when the stream said nothing', () => {
    // A run that reported no usage and a run that spent nothing are different
    // facts. Recording the first as zero understates a bill.
    expect(accumulateCost([{ type: 'system', subtype: 'init' }])).toEqual(NO_COST);
    expect(accumulateCost([]).source).toBe('none');
  });

  it('ignores a usage field that is not a number', () => {
    const cost = accumulateCost([
      { type: 'result', usage: { input_tokens: 'lots', output_tokens: 5 } },
    ]);

    expect(cost.inputTokens).toBe(0);
    expect(cost.outputTokens).toBe(5);
    expect(cost.source).toBe('result');
  });

  it('takes the last result event when a stream carries more than one', () => {
    const cost = accumulateCost([
      { type: 'result', total_cost_usd: 0.1, usage: { input_tokens: 1 } },
      { type: 'result', total_cost_usd: 0.9, usage: { input_tokens: 9 } },
    ]);

    expect(cost.costUsd).toBe(0.9);
  });
});

describe('describing it to an operator', () => {
  it('says when the total was added up rather than reported', () => {
    const summary = describeCost(accumulateCost([assistant(1_000, 200)]));

    // The alternative - printing both readings identically - trains the
    // operator to read an estimate as a bill (R10).
    expect(summary).toContain('added up from messages');
    expect(summary).not.toContain('$');
  });

  it('says nothing was reported rather than printing a zero', () => {
    expect(describeCost(NO_COST)).toBe('No usage reported.');
  });

  it('prices a reported total', () => {
    const summary = describeCost(
      accumulateCost([
        { type: 'result', total_cost_usd: 1.5, num_turns: 1, usage: { input_tokens: 2_000 } },
      ]),
    );

    expect(summary).toContain('$1.50');
    expect(summary).toContain('1 turn');
    expect(summary).not.toContain('added up');
  });
});
