/**
 * Moves `id` to where `overId` currently sits.
 *
 * Column order is shared pipeline structure, so the board persists the result
 * through its API. This helper only computes the next local order for the
 * optimistic drag response.
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
