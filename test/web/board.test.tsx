import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Board } from '../../src/web/src/Board.js';
import type { Card } from '../../src/web/src/api.js';
import { buttons, click, keyDown, makeCard, typeInto } from './dom.js';

/**
 * The board end to end, against a stubbed server.
 *
 * `Board` takes no props - it fetches everything itself - so the seam is
 * `fetch`. That is the point rather than an inconvenience: the tile's own
 * tests prove it calls its handler, and these prove the handler reaches the
 * right endpoint with the right method, which is the half a screenshot of a
 * pressed button never showed.
 */

const columns = [
  {
    id: 'col-ready',
    name: 'Ready',
    position: 0,
    isReady: true,
    isReviewGate: false,
    isTerminal: false,
  },
  {
    id: 'col-done',
    name: 'Done',
    position: 1,
    isReady: false,
    isReviewGate: false,
    isTerminal: true,
  },
];

const ready = makeCard({ id: 'card-ready', title: 'A card that can run', columnId: 'col-ready' });
const running = makeCard({
  id: 'card-running',
  title: 'A card mid-flight',
  columnId: 'col-ready',
  status: 'running',
  position: 1,
});
const stuck = makeCard({
  id: 'card-stuck',
  title: 'A card that cannot run',
  columnId: 'col-ready',
  status: 'blocked',
  position: 2,
});
const finished = makeCard({
  id: 'card-done',
  title: 'A card already finished',
  columnId: 'col-done',
  status: 'done',
});

const dispatchState = {
  mode: 'manual',
  policy: 'review',
  concurrency: 1,
  running: ['card-running'],
  completed: [],
  halted: null,
  budget: null,
  spend: { tokens: 0, runs: 0, unrecorded: 0 },
  spendNote: '',
  failureStreak: 0,
};

/** Every request the component made, in order, so a test can assert on one. */
let sent: { method: string; url: string; body: unknown }[];
let cards: Card[];

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200 });
}

function stubServer(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      sent.push({
        method,
        url,
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
      });

      if (url === '/health') return json({ build: null });
      if (url === '/api/boards') return json([{ id: 'board-1', name: 'kanban', cwd: '/tmp' }]);
      if (url.endsWith('/columns')) return json(columns);
      if (url.endsWith('/cards')) return json(cards);
      if (url.endsWith('/dispatch')) return json(dispatchState);
      if (url.endsWith('/dispatchable')) return json([{ id: 'card-ready', title: ready.title }]);
      if (url.endsWith('/dispatch-standing')) {
        return json([
          { id: 'card-ready', reason: null, offer: true },
          { id: 'card-running', reason: 'Already running', offer: true },
          { id: 'card-stuck', reason: 'Blocked on a dependency', offer: true },
          // A finished card is offered nothing at all, which is how the tile
          // knows to draw no control rather than a disabled one.
          { id: 'card-done', reason: 'In a terminal column', offer: false },
        ]);
      }
      if (url.endsWith('/cancel')) return json({ cancelled: true });
      if (url.endsWith('/archive')) return json(cards[0]);
      if (url.startsWith('/api/cards/')) {
        // Applied, not merely acknowledged. The board reloads after every
        // write, so a server that answered 200 and forgot would let a rename
        // that never persisted still look like it worked.
        const patch =
          typeof init?.body === 'string' ? (JSON.parse(init.body) as Partial<Card>) : {};
        const id = url.split('/')[3];
        cards = cards.map((card) => (card.id === id ? { ...card, ...patch } : card));
        return json(cards.find((card) => card.id === id));
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    }),
  );

  /**
   * The change feed. jsdom has no `EventSource`, and `subscribe` constructs one
   * unconditionally on mount, so without this the board throws before it
   * renders. A stub, not a fake stream: these tests drive change through the
   * component's own reload, which is what a live event would have triggered.
   */
  vi.stubGlobal(
    'EventSource',
    class {
      addEventListener(): void {}
      removeEventListener(): void {}
      close(): void {}
    },
  );
}

/** The request a test is asking about, or undefined if it was never made. */
function requestTo(fragment: string, method = 'POST'): { url: string; body: unknown } | undefined {
  return sent.find((entry) => entry.method === method && entry.url.includes(fragment));
}

/** The tile whose accessible name starts with this title. */
function tile(container: HTMLElement, title: string): HTMLLIElement {
  const found = [...container.querySelectorAll('li')].find((item) =>
    item.getAttribute('aria-label')?.startsWith(title),
  );
  expect(found, `no tile for ${title}`).toBeDefined();
  return found as HTMLLIElement;
}

describe('Board', () => {
  let container: HTMLDivElement;
  let root: Root;

  async function mount(): Promise<void> {
    await act(async () => {
      root.render(<Board />);
    });
    // The board loads in two waves - boards, then everything keyed by board -
    // so one flush leaves it half-populated.
    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
    });
  }

  /** Lets the handler's request and the reload that follows it settle. */
  async function settle(): Promise<void> {
    for (let i = 0; i < 4; i += 1) {
      await act(async () => {
        await Promise.resolve();
      });
    }
  }

  beforeEach(async () => {
    sent = [];
    cards = [ready, running, stuck, finished];
    stubServer();
    window.localStorage.clear();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await mount();
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.unstubAllGlobals();
  });

  it('draws the columns and every card in them', () => {
    expect(container.textContent).toContain('Ready');
    expect(container.textContent).toContain('A card that can run');
    expect(container.textContent).toContain('A card mid-flight');
    expect(container.textContent).toContain('A card already finished');
  });

  describe('the dispatch control', () => {
    it('dispatches the eligible card', async () => {
      const [run] = buttons(tile(container, 'A card that can run'), 'Run');
      expect(run?.disabled).toBe(false);

      await act(async () => {
        click(run as HTMLButtonElement);
      });
      await settle();

      expect(requestTo('/cards/card-ready/dispatch')?.url).toBe(
        '/api/boards/board-1/cards/card-ready/dispatch',
      );
    });

    it('stops the running card, and offers it no Run', async () => {
      const flying = tile(container, 'A card mid-flight');
      expect(buttons(flying, 'Run')).toHaveLength(0);

      const [stop] = buttons(flying, 'Stop');
      await act(async () => {
        click(stop as HTMLButtonElement);
      });
      await settle();

      expect(requestTo('/cards/card-running/cancel')?.url).toBe(
        '/api/boards/board-1/cards/card-running/cancel',
      );
    });

    /**
     * The reason comes from the server's own standing endpoint, so the button
     * cannot disagree with what a dispatch would actually do.
     */
    it('disables the control on an ineligible card and shows the server’s reason', () => {
      const [run] = buttons(tile(container, 'A card that cannot run'), 'Run');
      expect(run?.disabled).toBe(true);
      expect(run?.title).toBe('Blocked on a dependency');
    });

    it('draws no control on a card the server does not offer one for', () => {
      const done = tile(container, 'A card already finished');
      expect(buttons(done, 'Run')).toHaveLength(0);
      expect(buttons(done, 'Stop')).toHaveLength(0);
    });
  });

  describe('the tile actions', () => {
    function openMenu(title: string): HTMLLIElement {
      const item = tile(container, title);
      const [trigger] = buttons(item, 'Actions for');
      act(() => {
        click(trigger as HTMLButtonElement);
      });
      return item;
    }

    it('renames through the card endpoint, and shows the new title afterwards', async () => {
      const item = openMenu('A card that can run');
      const [edit] = buttons(item, 'Edit name');
      act(() => {
        click(edit as HTMLButtonElement);
      });

      const input = item.querySelector<HTMLInputElement>('input[aria-label="Card name"]');
      act(() => {
        typeInto(input as HTMLInputElement, 'A renamed card');
      });
      await act(async () => {
        keyDown(input as HTMLInputElement, 'Enter');
      });
      await settle();

      const request = requestTo('/api/cards/card-ready', 'PATCH');
      expect(request?.body).toEqual({ title: 'A renamed card' });
      // Survives the reload that follows the write. The board renames
      // optimistically and then refetches, so a title that is still on screen
      // here is one the server was actually told about.
      expect(container.textContent).toContain('A renamed card');
      expect(container.textContent).not.toContain('A card that can run');
    });

    it('archives rather than deletes', async () => {
      const item = openMenu('A card that can run');
      expect(item.textContent).not.toContain('Delete');

      const [archive] = buttons(item, 'Archive');
      await act(async () => {
        click(archive as HTMLButtonElement);
      });
      await settle();

      const request = requestTo('/api/cards/card-ready/archive');
      expect(request?.url).toBe('/api/cards/card-ready/archive');
      expect(request?.body).toEqual({ archived: true });
      // Never the destructive endpoint, whatever the menu grows later.
      expect(sent.some((entry) => entry.method === 'DELETE')).toBe(false);
    });
  });

  describe('failure', () => {
    /**
     * A load that fails partway must say why. The board is known by then, so
     * the columns render - and without the banner, a board whose columns could
     * not be fetched is indistinguishable from a board with no columns.
     */
    it('names the reason a load failed', async () => {
      act(() => {
        root.unmount();
      });
      vi.mocked(fetch).mockImplementation(async (input: string | URL | Request) => {
        const url = String(input);
        if (url === '/health') return json({ build: null });
        if (url === '/api/boards') return json([{ id: 'board-1', name: 'kanban', cwd: '/tmp' }]);
        return new Response(JSON.stringify({ error: 'The board database is locked' }), {
          status: 500,
        });
      });

      root = createRoot(container);
      await mount();

      expect(container.textContent).toContain('The board database is locked');
    });
  });
});
