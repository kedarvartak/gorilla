import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Activity, type HookEvent } from '../../src/web/src/Activity.js';

/**
 * The live feed.
 *
 * An operator who cannot see work in progress cannot tell a busy agent from a
 * wedged one, so the assertions are about attribution and about the two
 * silences reading differently.
 */

let container: HTMLDivElement;
let root: Root;
let listeners: ((message: MessageEvent<string>) => void)[];

class FakeEventSource {
  addEventListener(name: string, handler: EventListener): void {
    if (name === 'hook') listeners.push(handler as (m: MessageEvent<string>) => void);
  }
  close(): void {
    /* nothing to release */
  }
}

function emit(over: Partial<HookEvent>): void {
  const entry: HookEvent = {
    id: 1,
    runId: 'run-1',
    cardId: 'card-1',
    event: 'PostToolUse',
    receivedAt: Date.UTC(2026, 0, 1, 12, 0, 0),
    toolName: 'Edit',
    target: 'src/server/app.ts',
    ...over,
  };
  for (const listener of listeners) {
    listener(new MessageEvent('hook', { data: JSON.stringify(entry) }));
  }
}

async function render(live = true): Promise<void> {
  await act(async () => {
    root.render(<Activity live={live} titleFor={(id) => (id === null ? 'unbound' : 'Card One')} />);
  });
}

beforeEach(() => {
  listeners = [];
  vi.stubGlobal('EventSource', FakeEventSource);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe('Activity', () => {
  it('names the card an event belongs to', async () => {
    await render();
    await act(async () => emit({}));

    // Showing that something is happening without saying to what is most of the
    // value missing.
    expect(container.textContent).toContain('Card One');
    expect(container.textContent).toContain('src/server/app.ts');
  });

  it('shows the newest first', async () => {
    await render();
    await act(async () => emit({ id: 1, target: 'first.ts' }));
    await act(async () => emit({ id: 2, target: 'second.ts' }));

    const rows = [...container.querySelectorAll('li')].map((li) => li.textContent ?? '');
    expect(rows[0]).toContain('second.ts');
    expect(rows[1]).toContain('first.ts');
  });

  it('drops the intent half of a tool call', async () => {
    await render();
    await act(async () => emit({ event: 'PreToolUse', target: 'noise.ts' }));

    // PreToolUse always arrives paired with an outcome; showing both doubles
    // the feed to say the same thing twice.
    expect(container.querySelectorAll('li')).toHaveLength(0);
  });

  it('does not repeat an event the stream resends', async () => {
    await render();
    await act(async () => emit({ id: 7 }));
    await act(async () => emit({ id: 7 }));

    // A feed that repeats itself looks like activity that is not happening.
    expect(container.querySelectorAll('li')).toHaveLength(1);
  });

  it('tells the two silences apart', async () => {
    await render(true);
    expect(container.textContent).toContain('Dispatch a card to see it work');

    await render(false);
    expect(container.textContent).toContain('Not receiving events');
  });

  it('reads an unbound session as such rather than as a card', async () => {
    await render();
    await act(async () => emit({ cardId: null }));

    expect(container.textContent).toContain('unbound');
  });
});
