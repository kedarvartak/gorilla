import { describe, expect, it } from 'vitest';

import {
  MAX_COLUMN_WIDTH,
  MIN_COLUMN_WIDTH,
  clampColumnWidth,
  loadColumnWidths,
  reorder,
  saveColumnWidths,
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

describe('resizing columns', () => {
  it('keeps widths inside the readable range', () => {
    expect(clampColumnWidth(100)).toBe(MIN_COLUMN_WIDTH);
    expect(clampColumnWidth(400)).toBe(400);
    expect(clampColumnWidth(900)).toBe(MAX_COLUMN_WIDTH);
  });

  it('remembers each board independently', () => {
    const storage = fakeStorage();
    saveColumnWidths(storage, 'one', { ready: 420 });
    saveColumnWidths(storage, 'two', { done: 280 });

    expect(loadColumnWidths(storage, 'one')).toEqual({ ready: 420 });
    expect(loadColumnWidths(storage, 'two')).toEqual({ done: 280 });
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
