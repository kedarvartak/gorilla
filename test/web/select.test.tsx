import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Select, type SelectOption } from '../../src/web/src/Select.js';

/**
 * The dropdown that replaced eight native selects.
 *
 * Two things are being protected here. The keyboard, because a listbox that is
 * only usable with a pointer is a regression on the `<select>` it replaced -
 * that one came with all of this for free. And the portal, because the reason
 * this component exists in a scrolling flap is that a list rendered where it
 * is used gets clipped by `overflow-y: auto`, and nothing about the rendered
 * output makes that mistake visible until someone opens the card.
 */

const OPTIONS: readonly SelectOption[] = [
  { value: 'manual', label: 'Manual', hint: 'Holds the queue.' },
  { value: 'automatic', label: 'Automatic', hint: 'Starts the next card itself.' },
  { value: 'paused', label: 'Paused' },
];

let container: HTMLDivElement;
let root: Root;

function render(props: Partial<Parameters<typeof Select>[0]> = {}): ReturnType<typeof vi.fn> {
  const onChange = vi.fn();
  act(() => {
    root.render(
      <Select
        label="Dispatch mode"
        value="manual"
        options={OPTIONS}
        onChange={onChange}
        {...props}
      />,
    );
  });
  return onChange;
}

function trigger(): HTMLButtonElement {
  const node = container.querySelector<HTMLButtonElement>('[role="combobox"]');
  if (node === null) throw new Error('No trigger.');
  return node;
}

/** The list, wherever in the document it ended up. */
function listbox(): HTMLElement | null {
  return document.body.querySelector<HTMLElement>('[role="listbox"]');
}

function rows(): HTMLElement[] {
  return [...(listbox()?.querySelectorAll<HTMLElement>('[role="option"]') ?? [])];
}

function press(key: string): void {
  act(() => {
    trigger().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
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

describe('closed', () => {
  it('shows the chosen option and nothing else', () => {
    render();

    expect(trigger().textContent).toContain('Manual');
    expect(listbox()).toBeNull();
    expect(trigger().getAttribute('aria-expanded')).toBe('false');
  });

  it('falls back to the placeholder when nothing is chosen', () => {
    render({ value: null, placeholder: 'another card' });

    expect(trigger().textContent).toContain('another card');
  });
});

describe('opening', () => {
  it('lists every option with what choosing it does', () => {
    render();
    act(() => trigger().click());

    const text = listbox()?.textContent ?? '';
    expect(text).toContain('Manual');
    // The sentence that used to be a `title` on the closed control.
    expect(text).toContain('Holds the queue.');
    expect(text).toContain('Starts the next card itself.');
  });

  it('renders outside the trigger, so a scrolling pane cannot clip it', () => {
    render();
    act(() => trigger().click());

    // The point of the portal. Inside `container` it would be inside the flap.
    expect(listbox()).not.toBeNull();
    expect(container.querySelector('[role="listbox"]')).toBeNull();
  });

  it('marks the chosen option, and only that one', () => {
    render({ value: 'automatic' });
    act(() => trigger().click());

    const selected = rows().filter((row) => row.getAttribute('aria-selected') === 'true');
    expect(selected).toHaveLength(1);
    expect(selected[0]?.textContent).toContain('Automatic');
  });

  it('asks its owner for options as it opens, not on mount', () => {
    const onOpen = vi.fn();
    render({ onOpen });

    // The card has sixty siblings and is usually never compared to any of them.
    expect(onOpen).not.toHaveBeenCalled();

    act(() => trigger().click());
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});

describe('choosing', () => {
  it('reports the value and closes', () => {
    const onChange = render();
    act(() => trigger().click());
    act(() => rows()[1]?.click());

    expect(onChange).toHaveBeenCalledWith('automatic');
    expect(listbox()).toBeNull();
  });

  it('closes on Escape without choosing anything', () => {
    const onChange = render();
    act(() => trigger().click());
    press('Escape');

    expect(listbox()).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
    // Focus comes back, or the keyboard is left nowhere.
    expect(document.activeElement).toBe(trigger());
  });

  it('closes when something outside it is pressed', () => {
    render();
    act(() => trigger().click());

    act(() => {
      document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    });

    expect(listbox()).toBeNull();
  });
});

describe('the keyboard', () => {
  it('opens on the value that is set, not on the top of the list', () => {
    render({ value: 'paused' });
    press('ArrowDown');

    // Third option, so the first arrow moves from there rather than from
    // "Manual" - otherwise every change starts by walking back.
    expect(rows()[2]?.id).toBe(trigger().getAttribute('aria-activedescendant'));
  });

  it('walks the list and picks with Enter', () => {
    const onChange = render();
    press('ArrowDown');
    press('ArrowDown');
    press('Enter');

    expect(onChange).toHaveBeenCalledWith('automatic');
  });

  it('stops at both ends rather than wrapping', () => {
    render();
    press('ArrowDown');
    press('ArrowUp');
    press('ArrowUp');

    expect(rows()[0]?.id).toBe(trigger().getAttribute('aria-activedescendant'));

    press('End');
    expect(rows()[2]?.id).toBe(trigger().getAttribute('aria-activedescendant'));
    press('ArrowDown');
    expect(rows()[2]?.id).toBe(trigger().getAttribute('aria-activedescendant'));
  });

  it('jumps to an option by typing its name', () => {
    render();
    act(() => trigger().click());
    press('p');

    expect(rows()[2]?.id).toBe(trigger().getAttribute('aria-activedescendant'));
  });

  it('leaves focus on the trigger while the list is open', () => {
    render();
    act(() => trigger().focus());
    press('ArrowDown');

    // `aria-activedescendant` moves instead. Focus inside a portal at the end
    // of the body puts the reading order and the tab order at odds with the
    // screen.
    expect(document.activeElement).toBe(trigger());
    expect(trigger().getAttribute('aria-activedescendant')).not.toBeNull();
  });
});
