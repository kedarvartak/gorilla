import type { Database } from 'better-sqlite3';

import { diffSummary, type DiffSummary } from '../worktree/diff.js';
import type { WorktreeManager } from '../worktree/manager.js';

/**
 * Two attempts at the same work, side by side (T61).
 *
 * The backlog asked for N runs of one card on N branches. Building that means
 * re-keying the worktree path, the lease primary key and the runs table - the
 * three pieces whose invariants exist to stop two agents sharing a checkout,
 * and the last three things worth destabilising for a comparison view.
 *
 * The cheap path already works: clone the card, run both, and there are two
 * branches. What was missing was the comparison, which is additive and is the
 * part the operator actually wanted.
 */

export interface Candidate {
  readonly cardId: string;
  readonly title: string;
  readonly status: string;
  readonly branch: string | null;
  readonly verify: string | null;
  readonly diff: DiffSummary;
  /** Tokens the card's runs recorded, or null when none did. */
  readonly tokens: number | null;
}

export interface Comparison {
  readonly candidates: readonly Candidate[];
  /** Paths both touched. Where the two attempts disagree, if they disagree. */
  readonly shared: readonly string[];
  readonly note: string;
}

interface CardRow {
  readonly id: string;
  readonly title: string;
  readonly status: string;
}

function tokensFor(sqlite: Database, cardId: string): number | null {
  const row = sqlite
    .prepare(
      `SELECT SUM(
         COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0)
         + COALESCE(cache_read_tokens, 0) + COALESCE(cache_creation_tokens, 0)
       ) AS tokens,
       SUM(CASE WHEN cost_source IS NOT NULL THEN 1 ELSE 0 END) AS recorded
       FROM runs WHERE card_id = ?`,
    )
    .get(cardId) as { tokens: number | null; recorded: number | null };

  // Null rather than zero when no run recorded usage. A candidate that looks
  // free next to one that cost 40k would win an argument it did not earn.
  return (row.recorded ?? 0) === 0 ? null : (row.tokens ?? 0);
}

export async function compareCards(input: {
  readonly sqlite: Database;
  readonly repoCwd: string;
  readonly manager: WorktreeManager;
  readonly cardIds: readonly string[];
  readonly verifyFor: (cardId: string) => string | null;
}): Promise<Comparison> {
  const candidates: Candidate[] = [];

  for (const cardId of input.cardIds) {
    const card = input.sqlite
      .prepare('SELECT id, title, status FROM cards WHERE id = ?')
      .get(cardId) as CardRow | undefined;

    if (card === undefined) continue;

    const workspace = input.manager.workspaceFor(cardId);
    const branch = workspace?.branch ?? null;

    candidates.push({
      cardId,
      title: card.title,
      status: card.status,
      branch,
      verify: input.verifyFor(cardId),
      diff: await diffSummary(input.repoCwd, branch),
      tokens: tokensFor(input.sqlite, cardId),
    });
  }

  const touched = candidates.map(
    (candidate) => new Set(candidate.diff.files.map((file) => file.path)),
  );

  const shared =
    touched.length < 2
      ? []
      : [...(touched[0] ?? [])].filter((path) => touched.every((set) => set.has(path))).sort();

  return { candidates, shared, note: describeComparison(candidates, shared) };
}

/**
 * The line that does the work.
 *
 * Not a recommendation. The board can see which candidate passed its verify
 * and which touched fewer files; it cannot see which one an operator will want
 * to maintain, and a board that picked would be making the judgement the
 * operator opened this screen to make.
 */
export function describeComparison(
  candidates: readonly Candidate[],
  shared: readonly string[],
): string {
  if (candidates.length < 2) return 'Nothing to compare: name two cards.';

  const passing = candidates.filter((candidate) => candidate.verify === 'passed');

  const verdict =
    passing.length === 0
      ? 'Neither has a passing verify.'
      : passing.length === candidates.length
        ? 'Both pass their verify.'
        : `Only "${passing[0]?.title ?? ''}" passes its verify.`;

  const overlap =
    shared.length === 0
      ? 'They touch no files in common, so they may not be alternatives at all.'
      : `${String(shared.length)} file(s) are touched by both, which is where they disagree.`;

  return `${verdict} ${overlap}`;
}
