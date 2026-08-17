import type { StoredEntry } from './dedupe.js';

/**
 * The surprise set (doc 08, P1).
 *
 * A card's surprises are the entries an operator would regret not reading. Not
 * "everything recorded" - a brief that always costs two minutes gets skipped
 * when there are thirty seconds, which is the original failure returning. Three
 * things earn the interruption, and nothing else does:
 *
 * - **Superseded**: something accepted is now false. The reversal is usually
 *   the most informative event in a long run, and it is invisible in the diff.
 * - **Assumption**: believed but never verified by tool output. If it is wrong,
 *   everything built on it is wrong, and no test will say so.
 * - **Changed but unmentioned**: a file the repository changed that the event
 *   stream never names. The operator has no reason to look at it otherwise.
 *
 * An ordinary decision, a risk, a question, a mechanical change entry: all real
 * ledger content, all optional reading. Widening this set is the one change
 * that would quietly undo the point of having it.
 *
 * This module is pure. It reads no database and no git: callers pass the stored
 * entries and the reality check they already had, which is what makes every
 * rule below testable from a literal.
 */

export type SurpriseKind = 'superseded' | 'assumption' | 'unmentioned-change';

/**
 * How the operator retires a surprise.
 *
 * Entry-backed surprises acknowledge through `operatorStatus` on that row.
 * A path has no row to write to, so it carries the path itself and the
 * acknowledgement layer above decides where to put it. Naming the target here
 * rather than leaving the caller to infer it from which optional field is set
 * is what makes "enough to acknowledge it" true of every item in the list.
 */
export type SurpriseTarget =
  | { readonly type: 'entry'; readonly entryId: string }
  | { readonly type: 'path'; readonly path: string };

export interface Surprise {
  /** Stable within a card, so a UI can key on it and an ack can name it. */
  readonly id: string;
  readonly kind: SurpriseKind;
  readonly cardId: string;
  /** One line, renderable as-is. */
  readonly headline: string;
  /** Supporting matter, when there is any. Never required to understand the headline. */
  readonly detail?: string;
  /** Why this is outstanding, in the operator's terms rather than the schema's. */
  readonly why: string;
  readonly filePaths: readonly string[];
  readonly sourceEventIds: readonly number[];
  readonly target: SurpriseTarget;
}

export interface SurpriseInput {
  readonly cardId: string;
  /** Every stored entry for the card, in the order storage returned them. */
  readonly entries: readonly StoredEntry[];
  /** From the reality check: changed on disk, absent from the event stream. */
  readonly changedButUnmentioned: readonly string[];
}

/**
 * Absent means unreviewed.
 *
 * An entry built in memory - by dedupe, by mechanical extraction - has never
 * been offered to an operator, so treating a missing status as "already judged"
 * would silently empty the set for exactly the entries that were never seen.
 */
function isUnreviewed(entry: StoredEntry): boolean {
  return (entry.operatorStatus ?? 'unreviewed') === 'unreviewed';
}

function isSuperseded(entry: StoredEntry): boolean {
  return entry.supersededBy !== undefined && entry.supersededBy !== null;
}

/**
 * Supersession wins when an entry is both.
 *
 * A superseded assumption is no longer an open question about the world - it is
 * a settled reversal - and reporting it twice would make the count of things
 * needing attention wrong.
 */
function kindOf(entry: StoredEntry): SurpriseKind | null {
  if (isSuperseded(entry)) return 'superseded';
  if (entry.kind === 'assumption') return 'assumption';
  return null;
}

function headlineFor(entry: StoredEntry, kind: SurpriseKind): string {
  return kind === 'superseded'
    ? `No longer true: ${entry.statement}`
    : `Assumed, never verified: ${entry.statement}`;
}

function whyFor(entry: StoredEntry, kind: SurpriseKind): string {
  return kind === 'superseded'
    ? 'This was accepted earlier in the run and later reversed.'
    : 'Nothing in the tool output confirmed this, and work was built on it.';
}

/**
 * The outstanding surprises for one card.
 *
 * Order is deliberate and stable: entries in storage order first, so a reversal
 * reads next to the work around it, then the unmentioned paths, which are the
 * quietest signal and the one worth ending on.
 */
export function surprisesFor(input: SurpriseInput): Surprise[] {
  const surprises: Surprise[] = [];

  for (const entry of input.entries) {
    if (!isUnreviewed(entry)) continue;

    const kind = kindOf(entry);
    if (kind === null) continue;

    surprises.push({
      id: `entry:${entry.id}`,
      kind,
      cardId: input.cardId,
      headline: headlineFor(entry, kind),
      ...(entry.detail === undefined ? {} : { detail: entry.detail }),
      why: whyFor(entry, kind),
      filePaths: entry.filePaths ?? [],
      sourceEventIds: entry.sourceEventIds,
      target: { type: 'entry', entryId: entry.id },
    });
  }

  // Deduplicated because git status and the commit-range diff can both name a
  // file, and one file is one thing to look at however many ways we noticed it.
  for (const path of [...new Set(input.changedButUnmentioned)]) {
    surprises.push({
      id: `path:${path}`,
      kind: 'unmentioned-change',
      cardId: input.cardId,
      headline: `Changed without being mentioned: ${path}`,
      why: 'The repository changed this file and the event stream never names it.',
      filePaths: [path],
      sourceEventIds: [],
      target: { type: 'path', path },
    });
  }

  return surprises;
}
