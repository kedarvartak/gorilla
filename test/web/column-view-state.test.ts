import { describe, expect, it } from 'vitest';

import { reorder } from '../../src/web/src/column-view-state.js';

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
