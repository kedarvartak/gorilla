/**
 * Where a run's time went (T32).
 *
 * A timeline of two hundred events, evenly spaced on the page, says a run
 * happened and nothing about its shape. The operator's question when a card
 * took four hours is which part took four hours, and the answer is almost
 * always either one tool call or a long silence - two things the list renders
 * identically.
 *
 * Derived from the gaps rather than reported by the agent, because nothing in
 * the hook stream says "thinking". What the events support is: an interval
 * inside a tool call, and an interval between them. That is a real distinction
 * and it is the one that answers the question.
 */

export type Interval =
  /** Between a tool being asked for and it answering: the tool ran. */
  | 'tool'
  /**
   * Between one thing finishing and the next being asked for.
   *
   * Named for what the board can see rather than for what the model was doing.
   * It covers thinking, waiting on the API, and being rate limited, and the
   * board cannot tell those apart - calling it "thinking" would assert one.
   */
  | 'between'
  /** The first event of a run has nothing before it. */
  | 'start';

export interface TimedEvent {
  readonly event: string;
  readonly receivedAt: number;
}

export interface Density {
  /** Milliseconds since the previous event. Zero for the first. */
  readonly sinceMs: number;
  readonly interval: Interval;
}

const OPENS = new Set(['PreToolUse']);
const CLOSES = new Set(['PostToolUse', 'PostToolUseFailure']);

/**
 * Classifies each event by what the interval before it was spent on.
 *
 * A tool call that never closed leaves the run "inside a tool" for everything
 * after it, which is the honest reading: the board saw a tool asked for and
 * never saw it answer, and it does not know when it stopped.
 */
export function densityOf(events: readonly TimedEvent[]): Density[] {
  let open = false;
  let previous: number | null = null;

  return events.map((event) => {
    const sinceMs = previous === null ? 0 : Math.max(0, event.receivedAt - previous);
    const interval: Interval = previous === null ? 'start' : open ? 'tool' : 'between';

    if (OPENS.has(event.event)) open = true;
    else if (CLOSES.has(event.event)) open = false;

    previous = event.receivedAt;
    return { sinceMs, interval };
  });
}

export interface Totals {
  readonly toolMs: number;
  readonly betweenMs: number;
  /** The longest single gap, and what it was. The usual answer to "why so long". */
  readonly longestMs: number;
  readonly longestInterval: Interval;
}

export function totalsOf(density: readonly Density[]): Totals {
  let toolMs = 0;
  let betweenMs = 0;
  let longestMs = 0;
  let longestInterval: Interval = 'start';

  for (const entry of density) {
    if (entry.interval === 'tool') toolMs += entry.sinceMs;
    if (entry.interval === 'between') betweenMs += entry.sinceMs;

    if (entry.sinceMs > longestMs) {
      longestMs = entry.sinceMs;
      longestInterval = entry.interval;
    }
  }

  return { toolMs, betweenMs, longestMs, longestInterval };
}

function human(ms: number): string {
  if (ms < 1_000) return `${String(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`;
  return `${String(Math.round(ms / 60_000))} minute(s)`;
}

/**
 * One line, and it leads with the longest gap.
 *
 * Totals are what a chart would show; the single longest interval is what
 * actually explains a four-hour card, and it is usually one call.
 */
export function describeDensity(totals: Totals): string {
  if (totals.toolMs === 0 && totals.betweenMs === 0) {
    return 'Too few events to say where the time went.';
  }

  const where =
    totals.longestInterval === 'tool'
      ? 'inside one tool call'
      : 'between a tool answering and the next being asked for';

  return `${human(totals.toolMs)} in tools, ${human(totals.betweenMs)} between them. The longest single gap was ${human(totals.longestMs)}, ${where}.`;
}
