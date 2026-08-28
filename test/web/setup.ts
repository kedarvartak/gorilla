/**
 * Setup for component tests.
 *
 * Runs for every test file, not just the DOM ones - Vitest has a single
 * `setupFiles` list - but the flag is meaningless outside a DOM environment, so
 * that costs nothing.
 *
 * React refuses to run `act()` unless this is set, and says so in a warning
 * rather than an error, which is how a component test can appear to pass while
 * asserting on a tree that was never committed.
 */
declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

/**
 * jsdom has no `ResizeObserver`, and the card detail measures every section
 * with one to lay them out.
 *
 * A stub rather than a polyfill: nothing in jsdom has a height, so a real
 * implementation would observe boxes that are all zero and report nothing the
 * assertions could use. What the tests need is for the component to mount and
 * commit, which is exactly what the absence of the constructor prevented.
 */
if (!('ResizeObserver' in globalThis)) {
  globalThis.ResizeObserver = class {
    observe(): void {
      /* nothing in jsdom has a size to report */
    }
    unobserve(): void {}
    disconnect(): void {}
  } as unknown as typeof ResizeObserver;
}
