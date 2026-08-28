import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CardDetail } from '../../src/web/src/CardDetail.js';

/**
 * What the card page says when there is no account to show.
 *
 * The first version left "Reading the transcript." up for ever whenever the
 * request failed - a sentence that was true for one tick and then never again,
 * in front of an operator waiting for a screen that was not coming. It happened
 * for real: a board rebuilt under a running process serves the new interface
 * from `dist/web` while answering from the old `dist/server`, so every route
 * the page has learned about since that process started returns 404.
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
  status: 'idle',
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

/**
 * Enough of a brief for the page to render. Taken from `merge-gate.test.tsx`,
 * which already renders this component - this test is not about the brief.
 */
const BRIEF = {
  headline: 'A card: nothing new',
  sections: [],
  unseenCount: 0,
  nothingNew: true,
  extraction: { configured: true, tokensSpent: 0, note: null },
  surprises: [],
};

function serve(narration: { status: number; body: unknown }): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) => {
      if (url.includes('/narration')) {
        return Promise.resolve({
          ok: narration.status < 400,
          status: narration.status,
          json: () => Promise.resolve(narration.body),
        });
      }
      if (url.includes('/brief')) {
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(BRIEF) });
      }
      if (url.includes('/detail')) {
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(DETAIL) });
      }
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
    }),
  );
}

async function render(): Promise<void> {
  await act(async () => {
    root.render(<CardDetail cardId="card-1" onClose={() => undefined} />);
  });
  await act(async () => {
    await Promise.resolve();
  });
  await act(async () => {
    await Promise.resolve();
  });
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe('when the account cannot be read', () => {
  it('names the cause of a 404 rather than claiming to still be reading', async () => {
    serve({ status: 404, body: { error: 'Not found' } });
    await render();

    const text = container.textContent ?? '';
    expect(text).toContain('older build than this page');
    // The sentence that was there before, and was not true.
    expect(text).not.toContain('Reading the transcript.');
  });

  it('passes on any other failure in the server’s own words', async () => {
    serve({ status: 500, body: { error: 'The transcript could not be opened.' } });
    await render();

    expect(container.textContent).toContain('The transcript could not be opened.');
  });
});

describe('when there is an account', () => {
  it('says which provider it came from, and shows what was recorded', async () => {
    serve({
      status: 200,
      body: {
        entries: [
          { runId: 'r1', seq: 0, at: null, kind: 'said', text: 'Reading the stamp.', tool: null },
          { runId: 'r1', seq: 1, at: null, kind: 'did', text: 'npm test', tool: 'Bash' },
        ],
        total: 2,
        provider: 'claude',
        withheldThinking: 0,
        note: null,
      },
    });
    await render();

    const text = container.textContent ?? '';
    expect(text).toContain('Reading the stamp.');
    // The argument, not just the tool: "Bash" says an agent ran something.
    expect(text).toContain('npm test');
    expect(text).toContain('claude');
  });

  it('carries the note about withheld reasoning', async () => {
    serve({
      status: 200,
      body: {
        entries: [{ runId: 'r1', seq: 0, at: null, kind: 'said', text: 'Done.', tool: null }],
        total: 1,
        provider: 'claude',
        withheldThinking: 9,
        note: 'The model thought 9 time(s) here and none of the words were kept.',
      },
    });
    await render();

    // Shown before the entries: an operator who reads to the bottom looking
    // for reasoning that was never handed over has already concluded the
    // feature is broken.
    expect(container.textContent).toContain('none of the words were kept');
  });
});
