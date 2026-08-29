import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CardDetail } from '../../src/web/src/CardDetail.js';

/**
 * The merge gate, as the operator meets it (P6).
 *
 * The server already refuses. What is asserted here is that the interface says
 * so before the click rather than after it, and that it never becomes a wall -
 * a disabled button with no way through would be worse than no gate at all.
 */

let container: HTMLDivElement;
let root: Root;

const CARD = {
  id: 'card-1',
  boardId: 'board-1',
  columnId: 'col-1',
  title: 'A card',
  body: '',
  position: 0,
  status: 'awaiting-review',
  goalCondition: 'something measurable',
  agentModel: null,
  priority: 'normal',
  agentEffort: null,
  synthesisModel: null,
  lastSeenAt: null,
  mergedAt: null,
  mergedInto: null,
  mergedBranch: null,
  updatedAt: 0,
  guardrailDetail: [],
};

const DETAIL = {
  card: CARD,
  verify: null,
  verifyNote: null,
  guardrailDetail: [],
  blockers: [],
  runs: [],
  realityNotes: [],
  workspace: { branch: 'gorilla/a-card', worktree: '/w/a', git: null },
  mergeTarget: 'main',
  verifyCommand: 'npm test',
};

function brief(surprises: unknown[]): unknown {
  return {
    headline: 'A card: nothing new',
    sections: [],
    unseenCount: 0,
    nothingNew: true,
    extraction: { configured: true, tokensSpent: 0, note: null },
    surprises,
  };
}

const SURPRISE = {
  id: 'entry:e1',
  kind: 'assumption',
  headline: 'Assumed, never verified: the exporter is only called from the CLI',
  why: 'Nothing in the tool output confirmed this, and work was built on it.',
  target: { type: 'entry', entryId: 'e1' },
};

function respondWith(surprises: unknown[]): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) => {
      if (url.includes('/brief')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(brief(surprises)) });
      }
      if (url.includes('/detail')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(DETAIL) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    }),
  );
}

async function render(): Promise<void> {
  await act(async () => {
    root.render(<CardDetail cardId="card-1" onClose={() => {}} />);
  });
  // The component loads detail, then brief, then marks the card seen.
  await act(async () => {
    await Promise.resolve();
  });
  await openPane('review');
}

/**
 * Opens one of the card's tabs.
 *
 * The card opens on its brief and the tabs filter, so a pane's content is not
 * in the document until it is chosen. These tests used to read it straight off
 * `container` because every group rendered at once.
 */
async function openPane(pane: string): Promise<void> {
  const tab = container.querySelector<HTMLButtonElement>(`#tab-${pane}`);
  if (tab === null) throw new Error(`No "${pane}" tab to open.`);
  await act(async () => {
    tab.click();
  });
}

function mergeButton(): HTMLButtonElement | undefined {
  return [...container.querySelectorAll('button')].find((button) =>
    (button.textContent ?? '').includes('merge'),
  );
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

describe('when something has not been read', () => {
  it('disables the merge and says how many', async () => {
    respondWith([SURPRISE]);
    await render();

    const button = mergeButton();
    // Refusing after the click would teach the operator the board is
    // unreliable rather than that something needs reading.
    expect(button?.disabled).toBe(true);
    expect(button?.textContent).toContain('1 to read');
  });

  it('explains itself beside the button, so the block is not a wall', async () => {
    respondWith([SURPRISE]);
    await render();

    // The explanation is a finding, so it is on the brief - the review pane
    // holds the button and a route to here.
    await openPane('brief');

    expect(container.textContent).toContain('Merge is blocked');
    expect(container.textContent).toContain('the exporter is only called from the CLI');
    // The accept control is the way through. Without it this is a wall.
    expect([...container.querySelectorAll('button')].some((b) => b.textContent === 'accept')).toBe(
      true,
    );
  });

  it('admits the gate is not a lock on the repository', async () => {
    respondWith([SURPRISE]);
    await render();

    await openPane('brief');

    // Claiming a guarantee the board cannot keep is the R10 failure aimed at
    // ourselves: the first terminal merge would betray the trust.
    expect(container.textContent).toContain('not a lock on the repository');
  });
});

describe('when nothing is outstanding', () => {
  it('offers the merge normally', async () => {
    respondWith([]);
    await render();

    const button = mergeButton();
    expect(button?.disabled).toBe(false);
    expect(button?.textContent).toContain('merge into main');
  });

  it('does not raise judgement at all', async () => {
    respondWith([]);
    await render();

    // A standing request is one the operator learns to scroll past.
    expect(container.textContent).not.toContain('Merge is blocked');
  });
});
