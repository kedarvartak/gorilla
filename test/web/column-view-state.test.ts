import { describe, expect, it } from 'vitest';

import {
  loadColumnWidths,
  reorder,
  resizeColumnShares,
  saveColumnWidths,
  totalColumnShares,
} from '../../src/web/src/column-view-state.js';

function fakeStorage(): Storage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => void values.delete(key),
    clear: () => values.clear(),
    key: (index) => [...values.keys()][index] ?? null,
    get length() {
      return values.size;
    },
  };
}

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

describe('moving a column', () => {
  it('puts the dragged column where the one it was dropped on sat', () => {
    expect(reorder(['a', 'b', 'c', 'd'], 'd', 'b')).toEqual(['a', 'd', 'b', 'c']);
    expect(reorder(['a', 'b', 'c', 'd'], 'a', 'c')).toEqual(['b', 'c', 'a', 'd']);
  });

  it('returns the same array when nothing would move', () => {
    const ids = ['a', 'b', 'c'];
    expect(reorder(ids, 'b', 'b')).toBe(ids);
    expect(reorder(ids, 'b', 'missing')).toBe(ids);
    expect(reorder(ids, 'missing', 'b')).toBe(ids);
  });
});
