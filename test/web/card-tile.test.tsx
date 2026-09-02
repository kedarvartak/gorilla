import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { DndContext } from '@dnd-kit/core';
import { SortableContext } from '@dnd-kit/sortable';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CardTile, type CardTileProps } from '../../src/web/src/CardTile.js';
import type { Card } from '../../src/web/src/api.js';
import { buttons, click, keyDown, makeCard, typeInto } from './dom.js';

/**
 * The tile carries every action that changes or destroys state, and until now
 * all of them were checked by looking at a screenshot. What a screenshot
 * cannot show is whether the handler fired, which is the whole of what these
 * assert.
 */

describe('CardTile', () => {
  let container: HTMLDivElement;
  let root: Root;
  let handlers: {
    onOpen: ReturnType<typeof vi.fn>;
    onRun: ReturnType<typeof vi.fn>;
    onCancel: ReturnType<typeof vi.fn>;
    onRename: ReturnType<typeof vi.fn>;
    onArchive: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    handlers = {
      onOpen: vi.fn(),
      onRun: vi.fn(),
      onCancel: vi.fn(),
      onRename: vi.fn(),
      onArchive: vi.fn(),
    };
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  /**
   * `useSortable` reads the drag context, so the tile cannot be rendered on its
   * own - a bare tile throws before any of this is reachable. The contexts are
   * the real ones rather than mocks: they are what the board mounts it inside.
   */
  function render(card: Card, props: Partial<CardTileProps> = {}): void {
    act(() => {
      root.render(
        <DndContext>
          <SortableContext items={[card.id]}>
            <ul>
              <CardTile
                card={card}
                unseen={false}
                runnable={false}
                whyNotRunnable={null}
                terminal={false}
                {...handlers}
                {...props}
              />
            </ul>
          </SortableContext>
        </DndContext>,
      );
    });
  }

  function openMenu(): void {
    const [trigger] = buttons(container, 'Actions for');
    expect(trigger).toBeDefined();
    act(() => {
      click(trigger as HTMLButtonElement);
    });
  }

  describe('the dispatch control', () => {
    it('offers Stop on a running card, and cancels it', () => {
      render(makeCard({ status: 'running' }), { runnable: false });

      const [stop] = buttons(container, 'Stop');
      expect(stop).toBeDefined();
      expect(buttons(container, 'Run')).toHaveLength(0);

      act(() => {
        click(stop as HTMLButtonElement);
      });
      expect(handlers.onCancel).toHaveBeenCalledOnce();
      expect(handlers.onRun).not.toHaveBeenCalled();
    });

    it('offers Run on a dispatchable card, and dispatches it', () => {
      render(makeCard(), { runnable: true });

      const [run] = buttons(container, 'Run');
      expect(run).toBeDefined();
      expect(run?.disabled).toBe(false);

      act(() => {
        click(run as HTMLButtonElement);
      });
      expect(handlers.onRun).toHaveBeenCalledWith(expect.objectContaining({ id: 'card-1' }));
    });

    /**
     * The reported bug was "the run button got erased" - four different rules
     * can refuse a dispatch, and removing the control collapsed all four into
     * an outcome indistinguishable from the button being gone. So the reason
     * has to be on the element, not merely absent.
     */
    it('disables Run on an ineligible card and carries the reason', () => {
      render(makeCard({ status: 'blocked' }), {
        runnable: false,
        whyNotRunnable: 'Waiting on a dependency that has not finished',
      });

      const [run] = buttons(container, 'Run');
      expect(run?.disabled).toBe(true);
      expect(run?.title).toBe('Waiting on a dependency that has not finished');
      expect(run?.getAttribute('aria-label')).toContain(
        'Waiting on a dependency that has not finished',
      );

      act(() => {
        click(run as HTMLButtonElement);
      });
      expect(handlers.onRun).not.toHaveBeenCalled();
    });

    /** A finished card is offered nothing: no reason, so no control. */
    it('draws no dispatch control in a terminal column', () => {
      render(makeCard({ status: 'done' }), { terminal: true, whyNotRunnable: null });

      expect(buttons(container, 'Run')).toHaveLength(0);
      expect(buttons(container, 'Stop')).toHaveLength(0);
    });
  });

  describe('the actions menu', () => {
    it('stays shut until the trigger is pressed', () => {
      render(makeCard());
      expect(buttons(container, 'Edit name')).toHaveLength(0);

      openMenu();
      expect(buttons(container, 'Edit name')).toHaveLength(1);
      expect(buttons(container, 'Archive')).toHaveLength(1);
    });

    /**
     * Archive rather than delete: deleting takes the card's runs and ledger
     * with it, which is the history this product exists to keep (issue #153).
     * A test that accepts either would let that decision be reverted silently.
     */
    it('archives the card and closes', () => {
      render(makeCard());
      openMenu();

      const [archive] = buttons(container, 'Archive');
      act(() => {
        click(archive as HTMLButtonElement);
      });

      expect(handlers.onArchive).toHaveBeenCalledWith(expect.objectContaining({ id: 'card-1' }));
      expect(buttons(container, 'Archive')).toHaveLength(0);
    });

    it('offers no delete', () => {
      render(makeCard());
      openMenu();
      expect(container.textContent).not.toContain('Delete');
    });
  });

  describe('renaming', () => {
    function startRename(): HTMLInputElement {
      openMenu();
      const [edit] = buttons(container, 'Edit name');
      act(() => {
        click(edit as HTMLButtonElement);
      });
      const input = container.querySelector<HTMLInputElement>('input[aria-label="Card name"]');
      expect(input).not.toBeNull();
      return input as HTMLInputElement;
    }

    it('commits the new title on Enter', () => {
      render(makeCard());
      const input = startRename();

      act(() => {
        typeInto(input, 'Test the tile and the board');
      });
      // Enter blurs the field rather than committing directly, so the commit
      // path is the same one a click elsewhere takes.
      act(() => {
        keyDown(input, 'Enter');
      });

      expect(handlers.onRename).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'card-1' }),
        'Test the tile and the board',
      );
      expect(container.querySelector('input[aria-label="Card name"]')).toBeNull();
    });

    it('reverts on Escape without renaming', () => {
      const card = makeCard();
      render(card);
      const input = startRename();

      act(() => {
        typeInto(input, 'Half-typed name');
      });
      act(() => {
        keyDown(input, 'Escape');
      });

      expect(handlers.onRename).not.toHaveBeenCalled();
      expect(container.textContent).toContain(card.title);

      // And the draft is gone, not merely hidden: reopening must not offer the
      // abandoned text back as though it had been kept.
      const reopened = startRename();
      expect(reopened.value).toBe(card.title);
    });

    it('does not rename to an empty or unchanged title', () => {
      const card = makeCard();
      render(card);

      const blank = startRename();
      act(() => {
        typeInto(blank, '   ');
      });
      act(() => {
        keyDown(blank, 'Enter');
      });
      expect(handlers.onRename).not.toHaveBeenCalled();

      const same = startRename();
      act(() => {
        typeInto(same, card.title);
      });
      act(() => {
        keyDown(same, 'Enter');
      });
      expect(handlers.onRename).not.toHaveBeenCalled();
    });
  });

  describe('the keyboard', () => {
    it('opens on o and dispatches on d, and leaves Enter to the drag sensor', () => {
      render(makeCard(), { runnable: true });
      const tile = container.querySelector('li') as HTMLLIElement;

      act(() => {
        keyDown(tile, 'o');
      });
      expect(handlers.onOpen).toHaveBeenCalledOnce();

      act(() => {
        keyDown(tile, 'd');
      });
      expect(handlers.onRun).toHaveBeenCalledOnce();

      act(() => {
        keyDown(tile, 'Enter');
      });
      expect(handlers.onOpen).toHaveBeenCalledOnce();
    });

    it('will not dispatch an ineligible card from the keyboard', () => {
      render(makeCard({ status: 'blocked' }), { runnable: false, whyNotRunnable: 'Not idle' });
      const tile = container.querySelector('li') as HTMLLIElement;

      act(() => {
        keyDown(tile, 'd');
      });
      expect(handlers.onRun).not.toHaveBeenCalled();
    });
  });
});
