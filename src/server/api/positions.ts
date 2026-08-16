/**
 * Card ordering within a column.
 *
 * Positions are spaced rather than consecutive, so the common case - dropping a
 * card between two others - writes one row instead of renumbering the column.
 * Renumbering every card on every drag would emit an SSE update per card and
 * make a board of any size feel heavy.
 *
 * Consecutive integers are only restored when the gap between neighbours runs
 * out, which after this spacing takes many insertions in the same place.
 */

export const POSITION_GAP = 1_000;

export interface Positioned {
  readonly id: string;
  readonly position: number;
}

/** The position for a card dropped at `index` among `siblings`. */
export function positionForIndex(siblings: readonly Positioned[], index: number): number {
  const ordered = [...siblings].sort((a, b) => a.position - b.position);

  if (ordered.length === 0) return POSITION_GAP;

  const clamped = Math.max(0, Math.min(index, ordered.length));

  if (clamped === 0) {
    const first = ordered[0];
    return first === undefined ? POSITION_GAP : first.position - POSITION_GAP;
  }

  if (clamped === ordered.length) {
    const last = ordered[ordered.length - 1];
    return last === undefined ? POSITION_GAP : last.position + POSITION_GAP;
  }

  const before = ordered[clamped - 1];
  const after = ordered[clamped];
  if (before === undefined || after === undefined) return POSITION_GAP;

  return (before.position + after.position) / 2;
}

/**
 * True when the gap has collapsed and neighbours can no longer be separated.
 *
 * Floating-point midpoints eventually stop producing a distinct value; at that
 * point the column needs renumbering rather than another halving.
 */
export function needsRenumber(siblings: readonly Positioned[]): boolean {
  const ordered = [...siblings].sort((a, b) => a.position - b.position);

  for (let i = 1; i < ordered.length; i += 1) {
    const previous = ordered[i - 1];
    const current = ordered[i];
    if (previous === undefined || current === undefined) continue;

    const gap = current.position - previous.position;
    if (gap <= Number.EPSILON * Math.max(1, Math.abs(current.position))) return true;
  }

  return false;
}

/** Evenly spaced positions preserving current order. */
export function renumber(siblings: readonly Positioned[]): Positioned[] {
  return [...siblings]
    .sort((a, b) => a.position - b.position)
    .map((sibling, index) => ({ id: sibling.id, position: (index + 1) * POSITION_GAP }));
}
