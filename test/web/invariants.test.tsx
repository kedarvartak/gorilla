import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Invariants, type Invariant } from '../../src/web/src/Invariants.js';

/**
 * The project rules panel (doc 12, output 2).
 *
 * The assertions are about the two things that make a standing rule useful: it
 * is stated once, and a second copy is refused loudly rather than accepted
 * quietly - a rule stated five ways is one nobody can rely on.
 */

let container: HTMLDivElement;
let root: Root;

const RULE: Invariant = {
  id: 'inv-1',
  statement: 'Every migration must be additive.',
  sourceCardId: null,
  createdAt: 1,
};

/** Answers the list request, and whatever the test says for writes. */
function server(rules: readonly Invariant[], write?: { ok: boolean; error?: string }): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((_url: string, init?: { method?: string }) =>
      init?.method === undefined
        ? Promise.resolve({ ok: true, json: () => Promise.resolve(rules) })
        : Promise.resolve({
            ok: write?.ok ?? true,
            json: () => Promise.resolve({ error: write?.error }),
          }),
    ),
  );
}

async function render(): Promise<void> {
  await act(async () => {
    root.render(<Invariants boardId="board-1" onClose={() => {}} />);
  });
}

function type(value: string): void {
  const input = container.querySelector('input');
  if (input === null) throw new Error('no input');
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.bind(
      input,
    );
    setter?.(value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function clickButton(label: string): Promise<void> {
  const button = [...container.querySelectorAll('button')].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (button === undefined) throw new Error(`no ${label} button`);
  await act(async () => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe('Invariants', () => {
  it('lists the rules the board carries', async () => {
    server([RULE]);
    await render();

    expect(container.textContent).toContain('Every migration must be additive.');
  });

  it('says who is carrying them', async () => {
    server([RULE]);
    await render();

    // The scope is the point: this is not one card's constraint.
    expect(container.textContent).toContain('every card this board dispatches');
  });

  it('treats an empty list as a state rather than an unfinished setup', async () => {
    server([]);
    await render();

    expect(container.textContent).toContain('No project rules yet');
  });

  it('names the card a rule was learned on', async () => {
    server([{ ...RULE, sourceCardId: 'abcdef1234' }]);
    await render();

    // A rule whose origin nobody knows is a rule nobody dares remove.
    expect(container.textContent).toContain('learned on abcdef12');
  });

  it('shows the refusal when a rule is already there', async () => {
    server([RULE], { ok: false, error: 'That invariant is already on this board.' });
    await render();

    type('Every migration must be additive.');
    await clickButton('Add');

    // Swallowing this would let the duplicate the panel exists to prevent
    // arrive by a shorter route, with the operator believing it worked.
    expect(container.textContent).toContain('already on this board');
  });

  it('does not send an empty rule', async () => {
    server([]);
    await render();

    await clickButton('Add');

    const calls = (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(calls.filter((call) => call[1] !== undefined)).toHaveLength(0);
  });
});
