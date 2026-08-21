import type { StreamEventPayload } from './launcher.js';

/**
 * What a run cost (T29).
 *
 * The board dispatches work that spends money while nobody is watching, and
 * until now it recorded no part of that. A ceiling cannot be enforced against
 * a figure nobody keeps, so this is the reading the budget items are built on.
 *
 * Two readings exist and they are not the same claim. The CLI's own `result`
 * event carries a total it computed, including anything the board never saw.
 * Adding up the per-message usage is an approximation of that total: it misses
 * whatever the stream did not report, and it has no dollar figure at all.
 * `source` says which reading a row holds, so nothing downstream can present
 * an estimate as a bill (R10).
 */

export interface RunCost {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheCreationTokens: number;
  /** The CLI's own figure. Null when the total was added up from messages. */
  readonly costUsd: number | null;
  readonly turns: number | null;
  readonly durationMs: number | null;
  readonly source: 'result' | 'messages' | 'none';
}

export const NO_COST: RunCost = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  costUsd: null,
  turns: null,
  durationMs: null,
  source: 'none',
};

interface Usage {
  readonly input_tokens?: unknown;
  readonly output_tokens?: unknown;
  readonly cache_read_input_tokens?: unknown;
  readonly cache_creation_input_tokens?: unknown;
}

/** A field that is present but not a number is treated as absent, not as zero. */
function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

function optional(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function usageOf(value: unknown): Usage | null {
  return typeof value === 'object' && value !== null ? value : null;
}

function add(into: Usage, totals: Mutable): void {
  totals.inputTokens += count(into.input_tokens);
  totals.outputTokens += count(into.output_tokens);
  totals.cacheReadTokens += count(into.cache_read_input_tokens);
  totals.cacheCreationTokens += count(into.cache_creation_input_tokens);
}

interface Mutable {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

/**
 * Reads a run's cost from its event stream.
 *
 * The `result` event wins outright when it carries usage. It is the CLI's own
 * accounting, it is the only source with a dollar figure, and preferring it
 * avoids double counting a turn that appeared both as a message and in the
 * total.
 */
export function accumulateCost(events: readonly StreamEventPayload[]): RunCost {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event === undefined || event.type !== 'result') continue;

    const usage = usageOf(event['usage']);
    if (usage === null) continue;

    const totals: Mutable = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    };
    add(usage, totals);

    return {
      ...totals,
      costUsd: optional(event['total_cost_usd']),
      turns: optional(event['num_turns']),
      durationMs: optional(event['duration_ms']),
      source: 'result',
    };
  }

  const totals: Mutable = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  };
  let turns = 0;

  for (const event of events) {
    if (event.type !== 'assistant') continue;

    const message = event['message'];
    const usage = usageOf(
      typeof message === 'object' && message !== null
        ? (message as { usage?: unknown }).usage
        : undefined,
    );
    if (usage === null) continue;

    add(usage, totals);
    turns += 1;
  }

  if (turns === 0) return NO_COST;

  // No dollar figure: the price of a token is not something the board knows,
  // and inventing one would be worse than reporting none.
  return { ...totals, costUsd: null, turns, durationMs: null, source: 'messages' };
}

/** Tokens the run was billed for, cache reads included. */
export function totalTokens(cost: RunCost): number {
  return cost.inputTokens + cost.outputTokens + cost.cacheReadTokens + cost.cacheCreationTokens;
}

function short(tokens: number): string {
  if (tokens < 1_000) return String(tokens);
  if (tokens < 1_000_000) return `${(tokens / 1_000).toFixed(tokens < 10_000 ? 1 : 0)}k`;
  return `${(tokens / 1_000_000).toFixed(1)}M`;
}

/**
 * One line for an operator.
 *
 * An added-up total says so. The alternative - printing both readings
 * identically - trains the operator to read an estimate as a bill.
 */
export function describeCost(cost: RunCost): string {
  if (cost.source === 'none') return 'No usage reported.';

  const parts = [`${short(totalTokens(cost))} tokens`];
  if (cost.costUsd !== null) parts.push(`$${cost.costUsd.toFixed(2)}`);
  if (cost.turns !== null) parts.push(`${String(cost.turns)} turn${cost.turns === 1 ? '' : 's'}`);
  if (cost.source === 'messages') parts.push('added up from messages');

  return parts.join(' · ');
}
