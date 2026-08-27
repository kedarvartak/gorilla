import { describe, expect, it } from 'vitest';

import {
  DEFAULT_COLUMN_SHARE,
  loadColumnWidths,
  resizeColumnShares,
  saveColumnWidths,
  totalColumnShares,
  loadCollapsed,
  reorder,
  saveCollapsed,
  toggle,
} from '../../src/web/src/column-view-state.js';

/**
 * What one operator has folded away.
 *
 * Kept out of the database on purpose: folding a column is a statement about
 * one screen, and writing it to the board would move a colleague's view while
 * they were reading it. The column *order* beside it is the opposite - shared
 * structure - and lives on the server.
 */

/** A Storage that can be made to fail, because the real one does. */
function fakeStorage(initial: Record<string, string> = {}): Storage & { failWrites: boolean } {
  const map = new Map(Object.entries(initial));
  return {
    failWrites: false,
    getItem: (key: string) => map.get(key) ?? null,
    setItem(this: { failWrites: boolean }, key: string, value: string) {
      if (this.failWrites) throw new Error('quota exceeded');
      map.set(key, value);
    },
    removeItem: (key: string) => void map.delete(key),
    clear: () => map.clear(),
    key: (index: number) => [...map.keys()][index] ?? null,
    get length() {
      return map.size;
    },
  } as Storage & { failWrites: boolean };
}

describe('remembering what is folded', () => {
  it('reads back what it wrote', () => {
    const storage = fakeStorage();
    saveCollapsed(storage, 'board-1', new Set(['done', 'review']));

    expect([...loadCollapsed(storage, 'board-1')].sort()).toEqual(['done', 'review']);
  });

  it('keeps boards apart', () => {
    // The columns of one board mean nothing on another, and a shared list
    // would fold a column on a board the operator has not opened yet.
    const storage = fakeStorage();
    saveCollapsed(storage, 'board-1', new Set(['done']));
    saveCollapsed(storage, 'board-2', new Set(['intake']));

    expect([...loadCollapsed(storage, 'board-1')]).toEqual(['done']);
    expect([...loadCollapsed(storage, 'board-2')]).toEqual(['intake']);
  });

  it('leaves no entry for a board with nothing folded', () => {
    const storage = fakeStorage();
    saveCollapsed(storage, 'board-1', new Set(['done']));
    saveCollapsed(storage, 'board-1', new Set());

    expect(storage.getItem('gorilla.collapsed-columns')).not.toContain('board-1');
  });

  it('shows every column when storage holds nothing', () => {
    expect(loadCollapsed(fakeStorage(), 'board-1').size).toBe(0);
  });

  it('shows every column rather than throwing on a corrupt value', () => {
    // Hand-edited, half-written, or left by an older build. The cost of
    // getting this wrong is that nothing is folded, which is where the
    // operator started.
    for (const raw of ['not json', '[]', 'null', '{"board-1":"done"}', '{"board-1":[1,2]}']) {
      const storage = fakeStorage({ 'gorilla.collapsed-columns': raw });
      expect(loadCollapsed(storage, 'board-1').size).toBe(0);
    }
  });

  it('keeps the board usable when storage refuses to write', () => {
    // Private browsing and a full quota both throw. Forgetting a fold is not
    // worth an error banner, and it is certainly not worth a broken board.
    const storage = fakeStorage();
    storage.failWrites = true;

    expect(() => saveCollapsed(storage, 'board-1', new Set(['done']))).not.toThrow();
  });
});

describe('folding and unfolding', () => {
  it('adds one that is not folded and removes one that is', () => {
    expect([...toggle(new Set(), 'done')]).toEqual(['done']);
    expect([...toggle(new Set(['done']), 'done')]).toEqual([]);
  });

  it('does not touch the set it was given', () => {
    // The caller holds this in React state and compares by reference.
    const before = new Set(['done']);
    toggle(before, 'intake');

    expect([...before]).toEqual(['done']);
  });
});

describe('moving a column', () => {
  it('puts the dragged column where the one it was dropped on sat', () => {
    expect(reorder(['a', 'b', 'c', 'd'], 'd', 'b')).toEqual(['a', 'd', 'b', 'c']);
    expect(reorder(['a', 'b', 'c', 'd'], 'a', 'c')).toEqual(['b', 'c', 'a', 'd']);
  });

  it('returns the same array when nothing would move', () => {
    // Compared by reference by the caller, which skips a needless round trip
    // to the server on a drag that ended where it started.
    const ids = ['a', 'b', 'c'];

    expect(reorder(ids, 'b', 'b')).toBe(ids);
    expect(reorder(ids, 'b', 'missing')).toBe(ids);
    expect(reorder(ids, 'missing', 'b')).toBe(ids);
  });
});

/**
 * The test that would have caught the loss.
 *
 * Both halves of this module - folding and widths - shipped in separate pull
 * requests a day apart, and the second rewrote the file from a branch that
 * predated the first. The merge was clean and deleted a feature, because
 * neither side's tests named anything the other side owned. Asserting that
 * both halves are still exported is cheap and fails loudly the next time.
 */
describe('this module holds both viewing preferences', () => {
  it('still exports folding and widths together', () => {
    for (const exported of [
      loadCollapsed,
      saveCollapsed,
      toggle,
      reorder,
      loadColumnWidths,
      saveColumnWidths,
      resizeColumnShares,
      totalColumnShares,
    ]) {
      expect(typeof exported).toBe('function');
    }
    expect(DEFAULT_COLUMN_SHARE).toBe(1);
  });
});

describe('dependent column widths', () => {
  const ids = ['one', 'two', 'three', 'four'];

  it('gives space removed from a middle column to the rightmost column', () => {
    const resized = resizeColumnShares({}, ids, 'two', -0.4);
    expect(resized).toMatchObject({ one: 1, two: 0.6, three: 1, four: 1.4 });
    expect(totalColumnShares(resized, ids)).toBe(4);
  });

  it('takes space for the final column from its predecessor', () => {
    const resized = resizeColumnShares({}, ids, 'four', 0.3);
    expect(resized).toMatchObject({ one: 1, two: 1, three: 0.7, four: 1.3 });
    expect(totalColumnShares(resized, ids)).toBe(4);
  });

  it('will not make the resized or absorbing column disappear', () => {
    const narrow = resizeColumnShares({}, ids, 'two', -20);
    const wide = resizeColumnShares({}, ids, 'two', 20);
    expect(narrow.two).toBeCloseTo(0.4);
    expect(wide.four).toBeCloseTo(0.4);
    expect(totalColumnShares(narrow, ids)).toBeCloseTo(4);
    expect(totalColumnShares(wide, ids)).toBeCloseTo(4);
  });

  it('remembers each board independently', () => {
    const storage = fakeStorage();
    saveColumnWidths(storage, 'one', { ready: 1.4, done: 0.6 });
    saveColumnWidths(storage, 'two', { done: 1.2 });
    expect(loadColumnWidths(storage, 'one')).toEqual({ ready: 1.4, done: 0.6 });
    expect(loadColumnWidths(storage, 'two')).toEqual({ done: 1.2 });
  });

  it('falls back safely when stored data is corrupt', () => {
    const storage = fakeStorage();
    storage.setItem('gorilla.column-widths', 'not json');
    expect(loadColumnWidths(storage, 'one')).toEqual({});
  });
});
