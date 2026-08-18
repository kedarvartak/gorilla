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
};

const UNSEEN: DigestEntry = {
  cardId: 'card-unseen',
  title: 'Quietly finished',
  status: 'awaiting-review',
  unseen: 4,
  headline: 'Quietly finished: 4 new entries',
  verify: 'passed',
};

function respondWith(entries: readonly DigestEntry[]): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve(entries) })),
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
