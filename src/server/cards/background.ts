import type { Database } from 'better-sqlite3';

import type { Db } from '../db/client.js';
import { blockersFor } from './eligibility.js';
import { NOTHING as NOTHING_TOUCHED, proposeBlastRadius } from './blast-radius.js';
import { findContradictions } from './contradictions.js';
import { cardsTouching, subsystemsForCard } from './subsystems.js';

/**
 * What the board already knows about a card, assembled for the agent that is
 * about to work on it (doc 12, the project model).
 *
 * The board computes all of this and shows it to the operator in the card
 * detail, and until now told the agent none of it. T19 exists, in its own
 * words, "so an agent inherits the prior finding" - and the finding reached
 * the screen and stopped there. The agent went in knowing its own title, its
 * own body and the project rules, and rediscovered the rest at the price of a
 * run.
 *
 * Nothing here is new evidence. Every field is read from a module that already
 * existed and already had a caller in `card-detail-routes.ts`, which is the
 * point: a second computation of the same facts would be a second thing to
 * keep in step, and the two would disagree on the day it mattered.
 *
 * What is deliberately not here:
 *
 * - **The ledger.** Accepted and rejected entries already have their own
 *   sections, placed by their own rules - rejections above establishments,
 *   the operator's note above both. Folding them in would flatten an ordering
 *   that was argued for.
 * - **Anything requiring a subprocess.** This is assembled on the dispatch
 *   path, where a per-card git call would be paid for every card in a batch.
 * - **Speculation.** A related card is a fact about which files two cards
 *   touched. A blast radius is a guess, and is labelled as one.
 */

export interface BackgroundRelated {
  readonly title: string;
  readonly shared: readonly string[];
}

export interface CardBackground {
  /** Paths this card's own earlier runs touched, by subsystem. */
  readonly touched: readonly string[];
  /** Earlier cards that changed the same files (T19). */
  readonly related: readonly BackgroundRelated[];
  /** A guess at what this card will touch, offered only before it has run (T18). */
  readonly blastRadius: string | null;
  /** This card's scope against a project rule (T16). */
  readonly contradictions: readonly string[];
  /** Cards this one waits on, and what state they are in. */
  readonly waitingOn: readonly string[];
  /** What earlier runs on this card did. */
  readonly previousRuns: readonly string[];
}

export const NOTHING_KNOWN: CardBackground = {
  touched: [],
  related: [],
  blastRadius: null,
  contradictions: [],
  waitingOn: [],
  previousRuns: [],
};

export interface BackgroundInput {
  readonly db: Db;
  readonly sqlite: Database;
  readonly boardId: string;
  readonly cardId: string;
  readonly title: string;
  readonly body: string;
  /** The card's guardrails as stored, for the scope check. */
  readonly guardrails: string | null;
  readonly previousRuns?: readonly string[];
}

export function assembleBackground(input: BackgroundInput): CardBackground {
  const subsystems = subsystemsForCard(input.sqlite, input.cardId);

  return {
    touched: subsystems.map((entry) => `${entry.subsystem} (${String(entry.paths)} path(s))`),
    related: cardsTouching(input.sqlite, input.boardId, input.cardId).map((card) => ({
      title: card.title,
      shared: card.shared,
    })),
    // Offered only while the card has no history of its own. Once it has run,
    // what it actually touched outranks a guess from similar wording, and
    // handing an agent both would make it weigh a fact against a guess.
    blastRadius:
      subsystems.length > 0
        ? null
        : describeRadiusForAgent(
            proposeBlastRadius(input.sqlite, input.boardId, input.title, input.cardId),
          ),
    contradictions: findContradictions(input.sqlite, input.boardId, {
      title: input.title,
      body: input.body,
      guardrails: input.guardrails,
    }).map(
      (found) =>
        `${found.where === 'scope' ? 'This card is scoped to' : 'This card mentions'} ${found.conflict}, and a project rule says: "${found.invariant}".`,
    ),
    waitingOn: blockersFor(input.db, input.cardId).map(
      (blocker) => `${blocker.title} (${blocker.status})`,
    ),
    previousRuns: input.previousRuns ?? [],
  };
}

/**
 * The blast radius as an agent should read it.
 *
 * `describeBlastRadius` is written for the operator and says "check it before
 * relying on it", which is the right instruction for a person looking at a
 * screen. An agent needs the stronger form: this is where similar work landed,
 * and it is not a list of files to change.
 */
function describeRadiusForAgent(radius: ReturnType<typeof proposeBlastRadius>): string | null {
  if (radius === NOTHING_TOUCHED || radius.paths.length === 0) return null;

  const paths = radius.paths.slice(0, 8).map((entry) => entry.path);
  const from = radius.from.map((card) => `"${card.title}"`).join(', ');

  return `${paths.join(', ')} - where ${from} landed. A guess from similar wording, not an instruction.`;
}

/** Whether there is anything worth putting in front of an agent. */
export function isEmpty(background: CardBackground): boolean {
  return (
    background.touched.length === 0 &&
    background.related.length === 0 &&
    background.blastRadius === null &&
    background.contradictions.length === 0 &&
    background.waitingOn.length === 0 &&
    background.previousRuns.length === 0
  );
}
