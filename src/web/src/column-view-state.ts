/**
 * How this operator is looking at the columns: which are folded, and how wide.
 *
 * Deliberately not on the server, unlike the column order beside it. Folding a
 * column, or dragging one wider, is a statement about the screen in front of
 * one person - "I am not working on review today" - and pushing it to the
 * database would move another operator's board while they were reading it.
 * Order is structure and is shared; these are viewing preferences and are not.
 *
 * Stored per board, because the columns of one board mean nothing on another.
 *
 * The width half of this file was lost. It shipped in #149 and was overwritten
 * a day later by #143, which rewrote this module for folding from a branch that
 * predated it - a clean merge that silently deleted a feature, because neither
 * side's tests covered the other's. It is restored here unchanged apart from
 * this note.
 */

/** Every column begins with one equal share of the board width. */
export const DEFAULT_COLUMN_SHARE = 1;
/** A resized lane cannot be reduced below 10% of the available board. */
export const MIN_COLUMN_FRACTION = 0.1;

const WIDTH_KEY = 'gorilla.column-widths';
type StoredWidths = Record<string, Record<string, number>>;

function readWidths(raw: string | null): StoredWidths {
  if (raw === null) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};

    const result: StoredWidths = {};
    for (const [boardId, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) continue;
      const widths: Record<string, number> = {};
      for (const [columnId, width] of Object.entries(value)) {
        // Values above 10 are from the earlier fixed-pixel implementation.
        // Ignoring them migrates that view back to equal shares safely.
        if (typeof width === 'number' && Number.isFinite(width) && width > 0 && width <= 10) {
          widths[columnId] = width;
        }
      }
      result[boardId] = widths;
    }
    return result;
  } catch {
    return {};
  }
}

/** Column width shares are a per-screen preference, so they stay in the browser. */
export function loadColumnWidths(storage: Storage, boardId: string): Record<string, number> {
  return readWidths(storage.getItem(WIDTH_KEY))[boardId] ?? {};
}

export function saveColumnWidths(
  storage: Storage,
  boardId: string,
  widths: Readonly<Record<string, number>>,
): void {
  const all = readWidths(storage.getItem(WIDTH_KEY));
  all[boardId] = { ...widths };
  try {
    storage.setItem(WIDTH_KEY, JSON.stringify(all));
  } catch {
    // Resizing still works for this page when storage is unavailable.
  }
}

export function totalColumnShares(
  widths: Readonly<Record<string, number>>,
  ids: readonly string[],
) {
  return ids.reduce((total, id) => total + (widths[id] ?? DEFAULT_COLUMN_SHARE), 0);
}

/**
 * Gives width to one column and takes exactly the same amount from another.
 *
 * The rightmost column absorbs changes, so narrowing a middle lane expands the
 * final lane instead of pulling the board left and leaving blank space. When
 * resizing the final lane, its immediate predecessor absorbs the difference.
 */
export function resizeColumnShares(
  widths: Readonly<Record<string, number>>,
  ids: readonly string[],
  id: string,
  delta: number,
): Record<string, number> {
  const index = ids.indexOf(id);
  if (index === -1 || ids.length < 2 || delta === 0) return { ...widths };

  const receiverId = index === ids.length - 1 ? ids[index - 1] : ids[ids.length - 1];
  if (receiverId === undefined) return { ...widths };

  const next = Object.fromEntries(ids.map((columnId) => [columnId, widths[columnId] ?? 1]));
  const total = totalColumnShares(next, ids);
  const minimum = total * MIN_COLUMN_FRACTION;
  const current = next[id] ?? DEFAULT_COLUMN_SHARE;
  const receiver = next[receiverId] ?? DEFAULT_COLUMN_SHARE;
  const change = Math.max(minimum - current, Math.min(delta, receiver - minimum));

  next[id] = current + change;
  next[receiverId] = receiver - change;
  return next;
}

const KEY = 'gorilla.collapsed-columns';

type Stored = Record<string, string[]>;

/** Parses whatever is in storage, treating anything unrecognised as nothing. */
function read(raw: string | null): Stored {
  if (raw === null) return {};

  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};

    const out: Stored = {};
    for (const [boardId, ids] of Object.entries(parsed as Record<string, unknown>)) {
      if (Array.isArray(ids))
        out[boardId] = ids.filter((id): id is string => typeof id === 'string');
    }
    return out;
  } catch {
    // A half-written or hand-edited value is not worth a broken board. The
    // cost of getting this wrong is that every column shows, which is the
    // state the operator started from anyway.
    return {};
  }
}

export function loadCollapsed(storage: Storage, boardId: string): ReadonlySet<string> {
  return new Set(read(storage.getItem(KEY))[boardId] ?? []);
}

export function saveCollapsed(storage: Storage, boardId: string, ids: ReadonlySet<string>): void {
  const all = read(storage.getItem(KEY));

  // An empty set is removed rather than stored as `[]`, so a board the
  // operator has never folded anything on leaves no trace to migrate later.
  if (ids.size === 0) delete all[boardId];
  else all[boardId] = [...ids];

  try {
    storage.setItem(KEY, JSON.stringify(all));
  } catch {
    // Private browsing, a full quota, or storage disabled outright. The board
    // still works; it just forgets. Nothing here is worth an error banner.
  }
}

export function toggle(ids: ReadonlySet<string>, id: string): ReadonlySet<string> {
  const next = new Set(ids);
  if (!next.delete(id)) next.add(id);
  return next;
}

/**
 * Moves `id` to where `overId` currently sits.
 *
 * Returns the input untouched when either id is absent or nothing would move,
 * so a caller can compare by reference and skip a needless write.
 */
export function reorder(ids: readonly string[], id: string, overId: string): readonly string[] {
  const from = ids.indexOf(id);
  const to = ids.indexOf(overId);
  if (from === -1 || to === -1 || from === to) return ids;

  const next = [...ids];
  next.splice(from, 1);
  next.splice(to, 0, id);
  return next;
}
