import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { LOGO_PATH } from '../../src/web/src/logo.js';
import { Sidebar } from '../../src/web/src/Sidebar.js';

/**
 * The mark, and the rail that collapsed around it.
 *
 * Two properties are worth holding here. One is that the tab icon and the
 * interface are still the same drawing, because they are necessarily two
 * copies. The other is that folding the rail to an icon strip did not quietly
 * remove the destinations from anybody who is not looking at it - which is the
 * way this kind of change usually goes wrong, and the way that is invisible in
 * a screenshot.
 */

// From the repository root rather than from `import.meta.url`: these run under
// jsdom, where the module URL is not a file: URL and cannot be resolved.
const html = readFileSync(resolve(process.cwd(), 'src/web/index.html'), 'utf8');

describe('the mark on the tab', () => {
  it('is the same drawing as the one in the rail', () => {
    const href = /href="(data:image\/svg\+xml,[^"]+)"/.exec(html)?.[1];
    expect(href, 'index.html has no data-URI favicon').toBeDefined();

    const svg = decodeURIComponent((href ?? '').replace('data:image/svg+xml,', ''));

    // The whole point of the assertion: `index.html` cannot import from
    // `logo.ts`, so the geometry is duplicated, and a change to one of them
    // that misses the other is silent everywhere except a browser tab.
    expect(svg).toContain(LOGO_PATH);
  });

  it('is punched through rather than painted over, so it survives a dark tab', () => {
    // A counter filled with white reads as a solid blob on a dark tab strip.
    // This is what that bug looked like when it was in the first draft.
    const href = /href="(data:image\/svg\+xml,[^"]+)"/.exec(html)?.[1] ?? '';
    const svg = decodeURIComponent(href.replace('data:image/svg+xml,', ''));

    expect(svg).toContain('evenodd');
    expect(svg).toContain('prefers-color-scheme');
  });
});

let container: HTMLDivElement;
let root: Root;

function render(over: Partial<Parameters<typeof Sidebar>[0]> = {}): void {
  act(() => {
    root.render(
      <Sidebar
        boardName="kanban"
        view="board"
        live
        spent="0k tokens today."
        activityOpen={false}
        onSelect={() => undefined}
        onToggleActivity={() => undefined}
        {...over}
      />,
    );
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
});

describe('the collapsed rail', () => {
  it('still names every destination, for anyone not looking at it', () => {
    render();

    // By accessible name, not by CSS. The labels are clipped rather than
    // removed precisely so this keeps working: a rail that swapped its text
    // out while narrow would be unreachable by screen reader and by voice.
    for (const name of ['Board', 'Digest', 'Order', 'Numbers', 'Rules', 'Activity']) {
      const found = [...container.querySelectorAll('button')].some(
        (button) => button.textContent?.trim() === name,
      );
      expect(found, `no button named ${name}`).toBe(true);
    }
  });

  it('starts narrow and widens only on hover or focus', () => {
    render();
    const panel = container.querySelector('nav > div');

    // Asserted as classes because jsdom has no hover and no layout. The widths
    // themselves are checked in a real browser; what can be checked here is
    // that the collapsed width is the one in the markup and the open width is
    // reachable from both a pointer and the keyboard.
    expect(panel?.className).toContain('w-14');
    expect(panel?.className).toContain('hover:w-52');
    expect(panel?.className).toContain('focus-within:w-52');
  });

  it('marks the current view, which is the only label a narrow rail cannot show', () => {
    render({ view: 'numbers' });

    const current = container.querySelector('[aria-current="page"]');
    expect(current?.textContent?.trim()).toBe('Numbers');
  });

  it('no longer prints the board name under the wordmark', () => {
    render({ boardName: 'kanban' });

    // It is still the header's tooltip, so the board remains identifiable;
    // what it is not is a line of type saying "kanban" beneath "Gorilla".
    const text = container.textContent ?? '';
    expect(text).toContain('Gorilla');
    expect(text).not.toContain('kanban');
    expect(container.querySelector('[title="kanban"]')).not.toBeNull();
  });
});
