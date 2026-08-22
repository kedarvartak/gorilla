import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Panel } from '../../src/web/src/Panel.js';

/**
 * The frame every overlay panel shares (T79).
 *
 * Five of these accumulated over a day - the digest, the activity feed, the
 * project rules, the order, the numbers - and each was a bare div. To anything
 * that is not a pair of eyes they were part of the board underneath: unnamed,
 * and impossible to leave without finding the close button with a mouse.
 */

let container: HTMLDivElement;
let root: Root;

async function show(onClose: () => void): Promise<void> {
  await act(async () => {
    root.render(
      <Panel title="Project rules" onClose={onClose}>
        <p>content</p>
      </Panel>,
    );
    await Promise.resolve();
  });
}

function dialog(): HTMLElement | null {
  return container.querySelector('[role="dialog"]');
}

async function press(key: string): Promise<void> {
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key }));
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

describe('an overlay panel', () => {
  it('says what it is', async () => {
    await show(() => undefined);

    // A dialog with no name is announced as "dialog", which tells the operator
    // that something happened and not what.
    expect(dialog()?.getAttribute('aria-label')).toBe('Project rules');
    expect(dialog()?.getAttribute('aria-modal')).toBe('true');
  });

  it('closes on escape', async () => {
    const closed: string[] = [];
    await show(() => closed.push('closed'));

    await press('Escape');

    // Otherwise leaving means finding the close button with a mouse.
    expect(closed).toHaveLength(1);
  });

  it('ignores other keys', async () => {
    const closed: string[] = [];
    await show(() => closed.push('closed'));

    await press('a');

    expect(closed).toHaveLength(0);
  });

  it('takes focus when it opens', async () => {
    await show(() => undefined);

    // Without this the keyboard stays on the board behind, where the next key
    // press does something invisible.
    expect(document.activeElement).toBe(dialog());
  });

  it('stops listening once it is gone', async () => {
    const closed: string[] = [];
    await show(() => closed.push('closed'));

    await act(async () => {
      root.render(<p>nothing</p>);
      await Promise.resolve();
    });
    await press('Escape');

    // A closed panel that still answered escape would close the next one.
    expect(closed).toHaveLength(0);
  });
});
