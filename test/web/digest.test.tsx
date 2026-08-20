import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Digest, type DigestEntry } from '../../src/web/src/Digest.js';

/**
 * The morning digest (U6).
 *
 * The ordering is the feature, so that is what is asserted: the server ranks by
 * significance and this screen must render that order without re-sorting it.
 */

let container: HTMLDivElement;
let root: Root;

const FAILED: DigestEntry = {
  cardId: 'card-failed',
  title: 'Verify broke',
  status: 'awaiting-review',
  unseen: 0,
  headline: 'Verify broke: nothing new',
  verify: 'failed',
  recency: 'moved',
  waitedFor: null,
};

const UNSEEN: DigestEntry = {
  cardId: 'card-unseen',
  title: 'Quietly finished',
  status: 'awaiting-review',
  unseen: 4,
  headline: 'Quietly finished: 4 new entries',
  verify: 'passed',
  recency: 'moved',
  waitedFor: null,
};

/** Real work, but not news: it was already sitting there when the operator left. */
const STALE: DigestEntry = {
  cardId: 'card-stale',
  title: 'Blocked since Tuesday',
  status: 'blocked',
  unseen: 0,
  headline: 'Blocked since Tuesday: nothing new',
  verify: null,
  recency: 'waiting',
  waitedFor: '3 days',
};

function respondWith(entries: readonly DigestEntry[]): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            since: Date.UTC(2026, 7, 19, 18, 0, 0),
            generatedAt: Date.UTC(2026, 7, 20, 8, 0, 0),
            entries,
          }),
      }),
    ),
  );
}

async function render(): Promise<void> {
  await act(async () => {
    root.render(<Digest boardId="board-1" onOpen={() => {}} onClose={() => {}} />);
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

describe('Digest', () => {
  it('renders the server’s order without re-sorting it', async () => {
    // The server already ranks a failed verify above unseen entries. Sorting
    // again here would be a second implementation of that rule.
    respondWith([FAILED, UNSEEN]);
    await render();

    const titles = [...container.querySelectorAll('li')].map((item) => item.textContent ?? '');
    expect(titles[0]).toContain('Verify broke');
    expect(titles[1]).toContain('Quietly finished');
  });

  it('says why each card is where it is', async () => {
    respondWith([FAILED, UNSEEN]);
    await render();

    expect(container.textContent).toContain('the board ran its verify and it did not pass');
    expect(container.textContent).toContain('4 entries you have not read');
  });

  it('carries the brief’s own headline rather than summarising again', async () => {
    respondWith([UNSEEN]);
    await render();

    expect(container.textContent).toContain('Quietly finished: 4 new entries');
  });

  it('answers the quiet morning in one line', async () => {
    respondWith([]);
    await render();

    expect(container.textContent).toContain('Nothing is active');
  });

  it('reports a failure to load rather than showing an empty morning', async () => {
    // An empty list and a broken request look identical, and one of them means
    // "you have nothing to do".
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve({ ok: false, status: 500 })),
    );
    await render();

    expect(container.textContent).toContain('Could not load the digest');
    expect(container.textContent).not.toContain('Nothing is active');
  });
});

describe('news against backlog', () => {
  it('keeps what moved apart from what was already sitting there', async () => {
    respondWith([UNSEEN, STALE]);
    await render();

    // One list would let a card blocked since Tuesday read exactly like one
    // that failed an hour ago, and the promise at the top of this screen would
    // stop being true.
    expect(container.textContent).toContain('Changed while you were away');
    expect(container.textContent).toContain('Already waiting when you left');
  });

  it('says how long a waiting card has been untouched', async () => {
    respondWith([STALE]);
    await render();

    // The number is the point: three days is a different problem from one night.
    expect(container.textContent).toContain('untouched for 3 days');
  });

  it('says nothing moved rather than leaving the section empty', async () => {
    respondWith([STALE]);
    await render();

    // A blank space reads as a rendering failure. A quiet night is a result.
    expect(container.textContent).toContain('Nothing moved in this window');
  });

  it('names the window it is reporting on', async () => {
    respondWith([UNSEEN]);
    await render();

    // "While you were away" is a claim about a period. Unstated, the operator
    // cannot tell whether a card is missing or merely older than the window.
    expect(container.textContent).toContain('since');
  });

  it('still says the quiet morning in one line', async () => {
    respondWith([]);
    await render();

    expect(container.textContent).toContain('Nothing is active');
    expect(container.textContent).not.toContain('Changed while you were away');
  });
});
