/** Width bounds keep a lane readable without letting one consume the board. */
export const DEFAULT_COLUMN_WIDTH = 320;
export const MIN_COLUMN_WIDTH = 240;
export const MAX_COLUMN_WIDTH = 640;

const WIDTH_KEY = 'gorilla.column-widths';
type StoredWidths = Record<string, Record<string, number>>;

export function clampColumnWidth(width: number): number {
  return Math.min(MAX_COLUMN_WIDTH, Math.max(MIN_COLUMN_WIDTH, Math.round(width)));
}

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
        if (typeof width === 'number' && Number.isFinite(width)) {
          widths[columnId] = clampColumnWidth(width);
        }
      }
      result[boardId] = widths;
    }
    return result;
  } catch {
    return {};
  }
}

/** Column widths are a per-screen preference, so they stay local to the browser. */
export function loadColumnWidths(storage: Storage, boardId: string): Record<string, number> {
  return readWidths(storage.getItem(WIDTH_KEY))[boardId] ?? {};
}

export function saveColumnWidths(
  storage: Storage,
  boardId: string,
  widths: Readonly<Record<string, number>>,
): void {
  const all = readWidths(storage.getItem(WIDTH_KEY));
  all[boardId] = Object.fromEntries(
    Object.entries(widths).map(([columnId, width]) => [columnId, clampColumnWidth(width)]),
  );
  try {
    storage.setItem(WIDTH_KEY, JSON.stringify(all));
  } catch {
    // Resizing still works for this page when storage is unavailable.
  }
}

/**
 * Moves `id` to where `overId` currently sits.
 * Column order remains shared board structure; resizing is independent of it.
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
