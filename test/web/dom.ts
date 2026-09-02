/**
 * Shared plumbing for the component tests.
 *
 * There is no testing-library here - `card-detail.test.tsx` drives React
 * through `createRoot` and raw DOM events, and these are the three things that
 * approach needs more than once: a whole `Card`, a click React will hear, and
 * a typed value React will not discard.
 */
import type { Card } from '../../src/web/src/api.js';

/**
 * A card with every field set, overridden per test.
 *
 * Written out in full rather than cast: the tile reads a dozen of these fields
 * and a partial fixture would let a field be renamed out from under the tests
 * without anything failing.
 */
export function makeCard(overrides: Partial<Card> = {}): Card {
  return {
    id: 'card-1',
    boardId: 'board-1',
    columnId: 'col-ready',
    title: 'Wire up the DOM test harness',
    body: 'Give test/web/ a real environment.',
    position: 0,
    status: 'idle',
    goalCondition: 'Vitest renders a component and passes.',
    agentProvider: 'claude',
    agentModel: null,
    priority: 'normal',
    agentEffort: null,
    tokenCeiling: null,
    synthesisModel: null,
    lastSeenAt: null,
    mergedAt: null,
    mergedInto: null,
    mergedBranch: null,
    updatedAt: Date.now(),
    guardrailDetail: [],
    rank: null,
    rankBlocked: false,
    looksFinished: false,
    ...overrides,
  };
}

/** React 19 listens at the root container, so every event has to bubble. */
export function click(element: Element): void {
  element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

export function keyDown(element: Element, key: string): void {
  element.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
}

/**
 * Types into a controlled input.
 *
 * Setting `.value` directly is invisible to React: it caches the last value on
 * the node and treats an unchanged cache as "nothing happened", so the change
 * handler never runs. Going through the prototype setter updates the node
 * without touching that cache, which is what makes the dispatched event count.
 */
export function typeInto(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

/** Every button whose visible text or aria-label matches. */
export function buttons(root: ParentNode, label: string): HTMLButtonElement[] {
  return [...root.querySelectorAll('button')].filter(
    (button) =>
      button.textContent?.trim() === label || button.getAttribute('aria-label')?.includes(label),
  );
}
