import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CardDetail } from '../../src/web/src/CardDetail.js';
import type { Card } from '../../src/web/src/api.js';

const card: Card = {
  id: 'card-1',
  boardId: 'board-1',
  columnId: 'col-1',
  title: 'Wire up the DOM test harness',
  body: 'Give test/web/ a real environment.',
  position: 0,
  status: 'idle',
  goalCondition: 'Vitest renders a component and passes.',
  agentModel: null,
  priority: 'normal',
  agentEffort: null,
  synthesisModel: null,
  lastSeenAt: null,
  updatedAt: 0,
  guardrailDetail: [],
};

const detail = {
  card,
  // The server parses the set, so the interface never re-derives the shape.
  guardrails: { scope: [], prohibit: [], allowTools: [], verify: null, maxTurns: null },
  verify: null,
  verifyNote: null,
  guardrailDetail: [],
  blockers: [],
  runs: [],
  realityNotes: [],
  workspace: null,
  mergeTarget: null,
  verifyCommand: null,
};

function stubFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/detail')) {
        return new Response(JSON.stringify(detail), { status: 200 });
      }
      if (url.endsWith('/brief')) {
        return new Response('not found', { status: 404 });
      }
      if (url.endsWith('/subagents')) {
        return new Response('[]', { status: 200 });
      }
      if (url.endsWith('/guardrail-proposals')) {
        return new Response('[]', { status: 200 });
      }
      if (url.endsWith('/seen')) {
        return new Response('{}', { status: 200 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }),
  );
}

describe('CardDetail', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    stubFetch();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.unstubAllGlobals();
  });

  it('renders the card title once the detail request resolves', async () => {
    await act(async () => {
      root.render(<CardDetail cardId={card.id} onClose={() => {}} />);
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(container.textContent).toContain('Wire up the DOM test harness');
  });
});

/**
 * The tabs divide the card, and the reason to check is that they once stopped.
 *
 * They were demoted to scroll shortcuts over a single surface holding all four
 * groups at once. Nothing looked broken - the bar was still there and still
 * highlighted - and the only visible symptom was that a card's whole life,
 * transcript included, arrived in one scroll. Asserting that the other panes
 * are absent is what makes that a failing test rather than a screenshot.
 */
describe('the tabs on a card', () => {
  let container: HTMLDivElement;
  let root: Root;

  async function open(): Promise<void> {
    await act(async () => {
      root.render(<CardDetail cardId={card.id} onClose={() => {}} />);
    });
    await act(async () => {
      await Promise.resolve();
    });
  }

  function choose(pane: string): void {
    const tab = container.querySelector<HTMLButtonElement>(`#tab-${pane}`);
    if (tab === null) throw new Error(`No "${pane}" tab.`);
    act(() => {
      tab.click();
    });
  }

  beforeEach(() => {
    stubFetch();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.unstubAllGlobals();
  });

  it('shows one pane and leaves the others out of the document', async () => {
    await open();

    // The card opens on its brief, which this stub refuses.
    expect(container.textContent).toContain('The brief could not be loaded.');
    // The specification's body is on another tab, so it is not here at all.
    expect(container.textContent).not.toContain('Give test/web/ a real environment.');

    choose('specification');

    expect(container.textContent).toContain('Give test/web/ a real environment.');
    expect(container.textContent).not.toContain('The brief could not be loaded.');
  });

  it('marks the open tab selected, and only that one', async () => {
    await open();
    choose('specification');

    const selected = [...container.querySelectorAll('[role="tab"]')].filter(
      (tab) => tab.getAttribute('aria-selected') === 'true',
    );

    expect(selected).toHaveLength(1);
    expect(selected[0]?.id).toBe('tab-specification');
  });

  it('closes on Escape, because the board it sits over is still there', async () => {
    const closed = vi.fn();
    await act(async () => {
      root.render(<CardDetail cardId={card.id} onClose={closed} />);
    });
    await act(async () => {
      await Promise.resolve();
    });

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });

    expect(closed).toHaveBeenCalled();
  });
});
