/**
 * Which columns this operator has folded away.
 *
 * Deliberately not on the server, unlike the column order beside it. Folding a
 * column is a statement about the screen in front of one person - "I am not
 * working on review today" - and pushing it to the database would move another
 * operator's board while they were reading it. Order is structure and is
 * shared; this is a viewing preference and is not.
 *
 * Stored per board, because the columns of one board mean nothing on another.
 */

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
