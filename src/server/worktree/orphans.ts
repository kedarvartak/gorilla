import type { Database } from 'better-sqlite3';

import type { Workspace } from './manager.js';

/**
 * Worktrees nothing is waiting on (T48).
 *
 * The backlog asked for a reaper that removes them on a schedule. That is
 * wrong here and doc 18 says why: an unreviewed worktree holds a night of an
 * agent's work, and deleting one because a process restarted is unrecoverable.
 * A scheduled remover would eventually do exactly that, at 3am, to the one
 * that mattered.
 *
 * So this finds them and says so. Removal stays where it already is: an
 * operator action, one worktree at a time, through a route that already
 * exists.
 */

export type OrphanReason =
  /** The card was deleted. Nothing can ever review this. */
  | 'no-card'
  /** The card merged. The branch is in, and the checkout is a leftover. */
  | 'merged'
  /** The operator abandoned the card. They have already decided. */
  | 'abandoned';

export interface Orphan {
  readonly cardId: string;
  readonly path: string;
  readonly branch: string;
  readonly reason: OrphanReason;
  /** The card's title, when there still is one. */
  readonly title: string | null;
}

interface CardRow {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly mergedAt: number | null;
}

export function findOrphans(sqlite: Database, workspaces: readonly Workspace[]): Orphan[] {
  if (workspaces.length === 0) return [];

  const cards = new Map(
    (
      sqlite
        .prepare('SELECT id, title, status, merged_at AS mergedAt FROM cards')
        .all() as CardRow[]
    ).map((card) => [card.id, card]),
  );

  const orphans: Orphan[] = [];

  for (const workspace of workspaces) {
    const card = cards.get(workspace.cardId);

    // No card at all. Nothing can review this and nothing ever will, which is
    // the only case with no argument on the other side.
    if (card === undefined) {
      orphans.push({ ...workspace, reason: 'no-card', title: null });
      continue;
    }

    if (card.mergedAt !== null) {
      orphans.push({ ...workspace, reason: 'merged', title: card.title });
      continue;
    }

    if (card.status === 'abandoned') {
      orphans.push({ ...workspace, reason: 'abandoned', title: card.title });
    }
  }

  return orphans;
}

const WHY: Record<OrphanReason, string> = {
  'no-card': 'the card was deleted',
  merged: 'the card merged',
  abandoned: 'the card was abandoned',
};

/**
 * What to tell the operator, or null when there is nothing to say.
 *
 * States that nothing is removed automatically, every time. An operator who
 * reads a list of removable things and assumes the board is handling it will
 * find the disks full and the board blameless.
 */
export function describeOrphans(orphans: readonly Orphan[]): string | null {
  if (orphans.length === 0) return null;

  const detail = orphans.map((orphan) => `${orphan.branch} (${WHY[orphan.reason]})`).join(', ');

  return `${String(orphans.length)} worktree(s) nothing is waiting on: ${detail}. Nothing removes them automatically - a worktree holds a night of an agent's work, and a scheduled remover would eventually take the one that mattered.`;
}
