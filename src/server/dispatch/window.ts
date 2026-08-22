/**
 * When a board is allowed to start work (T41).
 *
 * "Define tasks, run them, go to sleep" has an unstated bound: the operator
 * wants the night, not the working day. A queue that keeps dispatching at
 * 09:30 is one competing with them for the same checkout, the same test
 * runner, and the same rate limit.
 *
 * A window holds the queue rather than halting it. A halt is sticky and asks
 * for a person; a hold is a fact about the clock that stops being true on its
 * own, and one that needed a manual resume every morning would be worse than
 * no window at all.
 */

export interface DispatchWindow {
  /** Local hour, 0-23, inclusive. */
  readonly fromHour: number;
  /** Local hour, 0-23, exclusive. */
  readonly toHour: number;
}

export function isValidHour(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 23;
}

/**
 * Whether the clock is inside the window.
 *
 * A window that wraps midnight is the normal case here, not an edge case: 22
 * to 07 is what "overnight" means. `from === to` is treated as always open
 * rather than as a zero-length window, because a board configured 9 to 9 that
 * silently never ran again would be indistinguishable from a broken queue.
 */
export function isOpen(window: DispatchWindow, at: Date): boolean {
  const hour = at.getHours();
  if (window.fromHour === window.toHour) return true;

  return window.fromHour < window.toHour
    ? hour >= window.fromHour && hour < window.toHour
    : hour >= window.fromHour || hour < window.toHour;
}

function pad(hour: number): string {
  return `${String(hour).padStart(2, '0')}:00`;
}

/** Said in the operator's terms, with the next opening, so a hold is legible. */
export function describeWindow(window: DispatchWindow, at: Date): string {
  return isOpen(window, at)
    ? `Dispatching between ${pad(window.fromHour)} and ${pad(window.toHour)}, which is now.`
    : `Holding until ${pad(window.fromHour)}. This board dispatches between ${pad(window.fromHour)} and ${pad(window.toHour)}.`;
}

/**
 * How long until the window opens, in milliseconds.
 *
 * Used to wake the queue rather than to poll it. A board asleep until 22:00
 * should not be asking the clock every minute whether it is 22:00 yet.
 */
export function msUntilOpen(window: DispatchWindow, at: Date): number {
  if (isOpen(window, at)) return 0;

  const next = new Date(at);
  next.setMinutes(0, 0, 0);
  next.setHours(window.fromHour);

  // Already past today's opening, so the next one is tomorrow's.
  if (next.getTime() <= at.getTime()) next.setDate(next.getDate() + 1);

  return next.getTime() - at.getTime();
}
