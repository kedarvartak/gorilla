import type { Surprise } from '../ledger/surprises.js';

/**
 * The merge gate (doc 08, P3).
 *
 * Layer one showed the operator what was surprising. Nothing made reading it
 * necessary, and a surface that can be scrolled past is advice rather than a
 * control. This is the layer with teeth: the board owns `mergeBranches`, so it
 * can decline to call it.
 *
 * The rule is deliberately blunt. Any card in the request with a surprise
 * nobody has judged refuses the whole request, and nothing is merged - not even
 * the cards that were clean. Merging the clean ones first would mean the
 * operator has to re-read a half-applied batch to find out where it stopped,
 * which is the cost the reviewer exists to remove.
 *
 * What this gate emphatically is not is a lock. The board is one caller of git
 * among many, and `git merge` in a terminal, a rebase in an editor, or a second
 * copy of this board all bypass it completely. Saying "blocked" without saying
 * that would be the board asserting a guarantee it cannot keep - R10 aimed at
 * ourselves - and would earn a trust that the first terminal merge betrays.
 */

/**
 * Said in every refusal, and worth its length.
 *
 * An operator who believes the branch is locked will not think to check what
 * else has touched it. That belief is more dangerous than no gate at all.
 */
export const GATE_REACH =
  'This is the board declining to merge for you, not a lock on the repository. ' +
  'A `git merge` run in a terminal, or any tool that is not this board, will ' +
  'merge these branches with nothing to stop it.';

export interface GateCard {
  readonly cardId: string;
  readonly title: string;
  readonly branch: string;
  /** The card's outstanding surprises, exactly as the brief reports them. */
  readonly surprises: readonly Surprise[];
}

export interface BlockedCard {
  readonly cardId: string;
  readonly title: string;
  readonly branch: string;
  readonly surprises: readonly {
    readonly id: string;
    readonly kind: Surprise['kind'];
    readonly headline: string;
    readonly why: string;
    readonly target: Surprise['target'];
  }[];
}

export interface GateRefusal {
  readonly error: string;
  /** The gate's own limits, stated rather than implied. */
  readonly reach: string;
  readonly blocked: readonly BlockedCard[];
  readonly outstanding: number;
  /** Named so the operator can see the clean cards were held back too. */
  readonly mergedNothing: true;
}

function countedCards(n: number): string {
  return n === 1 ? '1 card' : `${String(n)} cards`;
}

function countedSurprises(n: number): string {
  return n === 1 ? '1 surprise' : `${String(n)} surprises`;
}

/**
 * Decides whether a merge request may proceed.
 *
 * Returns `null` when it may. The refusal carries every outstanding surprise
 * rather than a count: "3 things need judging" sends the operator hunting, and
 * the hunt is what makes a gate feel like an obstacle instead of a summary.
 */
export function mergeGate(cards: readonly GateCard[]): GateRefusal | null {
  const blocked: BlockedCard[] = cards
    .filter((card) => card.surprises.length > 0)
    .map((card) => ({
      cardId: card.cardId,
      title: card.title,
      branch: card.branch,
      surprises: card.surprises.map((surprise) => ({
        id: surprise.id,
        kind: surprise.kind,
        headline: surprise.headline,
        why: surprise.why,
        target: surprise.target,
      })),
    }));

  if (blocked.length === 0) return null;

  const outstanding = blocked.reduce((total, card) => total + card.surprises.length, 0);
  const clean = cards.length - blocked.length;

  return {
    error:
      `Nothing was merged: ${countedCards(blocked.length)} of ${String(cards.length)} ` +
      `${cards.length === 1 ? 'has' : 'have'} ${countedSurprises(outstanding)} nobody has judged` +
      (clean === 0
        ? '.'
        : `, so the ${countedCards(clean)} that ${clean === 1 ? 'was' : 'were'} clean ` +
          'stayed unmerged too rather than leaving you a half-applied batch.') +
      ' Judge them on the card, or merge outside the board.',
    reach: GATE_REACH,
    blocked,
    outstanding,
    mergedNothing: true,
  };
}

/**
 * How a changed-but-unmentioned path is retired.
 *
 * An entry-backed surprise acknowledges through `operatorStatus` on its row. A
 * path has no row, so the acknowledgement is written as one: a `change` entry
 * naming the path, already judged. The prefix is what tells it apart from an
 * ordinary change entry, which is a sentinel in text rather than a column
 * because the acknowledgement has to be storable without a migration.
 *
 * Narrow on purpose. Any judged entry that happens to name the file would be a
 * looser rule and would retire surprises the operator never looked at.
 */
export const PATH_ACK_PREFIX = 'Looked at, unmentioned by the run: ';

interface JudgeableEntry {
  readonly statement: string;
  readonly filePaths?: readonly string[];
  readonly operatorStatus?: string | undefined;
}

/** The paths an operator has explicitly said they have looked at. */
export function acknowledgedPaths(entries: readonly JudgeableEntry[]): Set<string> {
  const paths = new Set<string>();

  for (const entry of entries) {
    if (!entry.statement.startsWith(PATH_ACK_PREFIX)) continue;
    if ((entry.operatorStatus ?? 'unreviewed') === 'unreviewed') continue;

    for (const path of entry.filePaths ?? []) paths.add(path);
  }

  return paths;
}
