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
