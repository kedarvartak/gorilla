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
