import type { Database } from 'better-sqlite3';

import { parseGuardrails } from './guardrails.js';

/**
 * A card that asks for something a project rule forbids (T16).
 *
 * Project rules reach every dispatched card, and a card whose own scope
 * contradicts one is a card that will either be refused by the settings
 * overlay mid-run, or - worse - talked past it, because the rules arrive as
 * two lists and the agent has to reconcile them. Either way the operator finds
 * out at the end.
 *
 * Narrower than the backlog entry claimed. "A card whose text conflicts with
 * an invariant" is not something this can detect: deciding whether prose
 * contradicts prose is the model's job, and doing it badly here would produce
 * a warning that is wrong often enough to be ignored. What is checkable is a
 * card naming a path a project rule prohibits, and that is what this does.
 */

export interface Contradiction {
  /** The project rule, as written. */
  readonly invariant: string;
  /** What the card says that runs into it. */
  readonly conflict: string;
  readonly where: 'scope' | 'body';
}

/** Wording that makes a rule a prohibition rather than an observation. */
const PROHIBITION = /\b(never|must not|do not|don'?t|should not|avoid)\b/i;

/**
 * A path-shaped token: has a separator or a dot, and no spaces.
 *
 * Matching on prose words instead would flag a rule saying "never guess" on
 * every card whose body contains the word guess.
 */
const PATHS = /[^\s,;"'`()]*[/.][^\s,;"'`()]+/g;

function pathsIn(text: string): string[] {
  return [...new Set(text.match(PATHS) ?? [])].filter((token) => token.length > 3);
}

export function findContradictions(
  sqlite: Database,
  boardId: string,
  card: { readonly title: string; readonly body: string; readonly guardrails: string | null },
): Contradiction[] {
  const invariants = sqlite
    .prepare('SELECT statement FROM invariants WHERE board_id = ?')
    .all(boardId) as { statement: string }[];

  const guardrails = parseGuardrails(card.guardrails);
  const scope = guardrails.scope.map((entry) => entry.toLowerCase());
  const text = `${card.title}\n${card.body}`.toLowerCase();

  const found: Contradiction[] = [];

  for (const rule of invariants) {
    if (!PROHIBITION.test(rule.statement)) continue;

    for (const path of pathsIn(rule.statement.toLowerCase())) {
      // The card's scope is the strong signal: it is a claim about where the
      // work will happen, made by whoever wrote the card, against a rule
      // saying it must not.
      const scoped = scope.find((entry) => entry.includes(path));
      if (scoped !== undefined) {
        found.push({ invariant: rule.statement, conflict: scoped, where: 'scope' });
        continue;
      }

      // The body is weaker - a card can mention a file it intends to leave
      // alone - so it is reported as a mention rather than as a conflict, and
      // the interface says which of the two it is.
      if (text.includes(path)) {
        found.push({ invariant: rule.statement, conflict: path, where: 'body' });
      }
    }
  }

  return found;
}

export function describeContradictions(found: readonly Contradiction[]): string | null {
  if (found.length === 0) return null;

  const first = found[0];
  if (first === undefined) return null;

  const strength =
    first.where === 'scope'
      ? `This card is scoped to ${first.conflict}`
      : `This card mentions ${first.conflict}`;

  // Named as worth a look rather than as an error. A rule can be prohibiting a
  // path precisely because this card is the one allowed to change it, and a
  // board that called that a mistake would be wrong on the most interesting
  // card it ever sees.
  return `${strength}, and a project rule says: "${first.invariant}". Worth a look before dispatching.`;
}
