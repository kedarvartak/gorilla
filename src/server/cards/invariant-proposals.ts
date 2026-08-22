import type { Database } from 'better-sqlite3';

import { parseGuardrails } from './guardrails.js';

/**
 * Noticing that a card rule has become a project rule (T15).
 *
 * A rule written onto three separate cards is not three card rules. It is one
 * project rule that nobody has written down, and the cost of leaving it that
 * way is drift: the fourth card gets a slightly different wording, the fifth
 * gets none, and the agent working the fifth has no idea the rule exists.
 *
 * Board invariants exist and reach every dispatched card (G5). What was
 * missing is anything noticing when one is warranted, which meant the feature
 * only helped an operator who already knew they had a standing rule.
 */

export interface InvariantProposal {
  readonly statement: string;
  /** The cards that already say it. Shown, because the claim is falsifiable. */
  readonly cards: readonly { readonly id: string; readonly title: string }[];
  readonly why: string;
}

/**
 * Three, not two.
 *
 * Two cards sharing a rule is ordinary: they are usually the same piece of
 * work split in half. Three is where it stops being about those cards.
 */
export const DEFAULT_THRESHOLD = 3;

interface CardRow {
  readonly id: string;
  readonly title: string;
  readonly guardrails: string | null;
}

/**
 * Matched on the normalised wording rather than the exact string.
 *
 * The same rule typed onto three cards by hand is three spellings of it, and a
 * proposer that only sees exact matches would miss precisely the case that
 * motivates the feature.
 */
function key(rule: string): string {
  return rule
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[.;]+$/, '');
}

export function proposeInvariants(
  sqlite: Database,
  boardId: string,
  threshold = DEFAULT_THRESHOLD,
): InvariantProposal[] {
  const cards = sqlite
    .prepare('SELECT id, title, guardrails FROM cards WHERE board_id = ?')
    .all(boardId) as CardRow[];

  const existing = new Set(
    (
      sqlite.prepare('SELECT statement FROM invariants WHERE board_id = ?').all(boardId) as {
        statement: string;
      }[]
    ).map((row) => key(row.statement)),
  );

  const seen = new Map<string, { statement: string; cards: { id: string; title: string }[] }>();

  for (const card of cards) {
    const guardrails = parseGuardrails(card.guardrails);
    // Prohibitions and scopes only. A verify command is a property of the
    // card's own work - "this card's tests" - and hoisting one to the project
    // would impose one card's check on every other card.
    const rules = [...guardrails.prohibit, ...guardrails.scope];

    // Deduplicated within the card: a card that lists a rule twice is one
    // card saying it, not two.
    for (const rule of new Set(rules.map(key))) {
      if (existing.has(rule)) continue;

      const original = rules.find((candidate) => key(candidate) === rule) ?? rule;
      const entry = seen.get(rule);

      if (entry === undefined) {
        seen.set(rule, { statement: original, cards: [{ id: card.id, title: card.title }] });
        continue;
      }
      entry.cards.push({ id: card.id, title: card.title });
    }
  }

  return [...seen.values()]
    .filter((entry) => entry.cards.length >= threshold)
    .map((entry) => ({
      statement: entry.statement,
      cards: entry.cards,
      why: `${String(entry.cards.length)} cards carry this rule. Stated once as a project rule it reaches every card, including the ones nobody remembered to write it on.`,
    }))
    .sort((left, right) => right.cards.length - left.cards.length);
}
