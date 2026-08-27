import { asc, eq } from 'drizzle-orm';

import type { DatabaseHandle } from '../db/client.js';
import { invariants, runs, type Card } from '../db/schema.js';
import { storedEntriesFor } from '../ledger/store.js';
import type { CardContextInput } from '../launcher/args.js';
import { assembleBackground } from './background.js';
import { parseGuardrails } from './guardrails.js';

/**
 * Everything that goes into the `card-context.md` a session is handed.
 *
 * One assembler, called by the dispatcher on its way to `launch` and by the
 * route the card detail reads. The alternative was for the interface to
 * describe the context separately, and a screen that says what the agent was
 * told while the agent is told something else is worse than a screen that
 * says nothing - the operator would review against the wrong text and never
 * find out.
 *
 * It reports what a run dispatched *now* would receive. That is not the same
 * claim as what a past run received: the ledger, the dependencies and the
 * subsystem map all move. Anything showing this to a person has to say so.
 */
export function cardContextInput(
  database: DatabaseHandle,
  card: Card,
  options: { readonly branch?: string | null } = {},
): CardContextInput {
  const entries = storedEntriesFor(database, card.id);

  return {
    title: card.title,
    body: card.body,
    guardrails: parseGuardrails(card.guardrails),
    branch: options.branch ?? null,
    invariants: database.db
      .select({ statement: invariants.statement })
      .from(invariants)
      .where(eq(invariants.boardId, card.boardId))
      .all()
      .map((row) => row.statement),
    acceptedEntries: entries
      .filter((entry) => entry.operatorStatus === 'accepted')
      .map((entry) => entry.statement),
    rejectedEntries: entries
      .filter((entry) => entry.operatorStatus === 'rejected')
      .map((entry) => entry.statement),
    operatorNote: card.retryNote,
    background: assembleBackground({
      db: database.db,
      sqlite: database.sqlite,
      boardId: card.boardId,
      cardId: card.id,
      title: card.title,
      body: card.body,
      guardrails: card.guardrails,
      previousRuns: previousRunsFor(database, card.id),
    }),
  };
}

/**
 * What earlier runs on this card did, in one line each.
 *
 * `renderCardContext` has rendered a "Previous runs" section since it was
 * written and nothing ever filled it, so every retry went in believing it was
 * the first attempt. Read from the runs table rather than from the
 * transcripts: the outcome and the branch are what a second attempt needs, and
 * re-reading a transcript per dispatch would put a file read per run on the
 * dispatch path.
 */
export function previousRunsFor(database: DatabaseHandle, cardId: string): string[] {
  return database.db
    .select()
    .from(runs)
    .where(eq(runs.cardId, cardId))
    .orderBy(asc(runs.startedAt))
    .all()
    .map((run, index) => {
      const when = new Date(run.startedAt).toISOString().slice(0, 16).replace('T', ' ');
      const branch = run.gitBranch === null ? '' : ` on ${run.gitBranch}`;
      return `Run ${String(index + 1)}, ${when}${branch}: ${outcomeOf(run)}.`;
    });
}

/**
 * What a run came to, in the plainest true form.
 *
 * `end_reason` is `other` on nine of the eleven runs in the real database and
 * `goal_outcome` is null on all of them, so the obvious rendering - print the
 * columns - produces "Run 1: other", which tells a second attempt nothing and
 * costs it a line of attention to find that out. Where the columns say
 * nothing, this says that, rather than dressing an absence up as a finding.
 */
function outcomeOf(run: {
  goalOutcome: string | null;
  endReason: string | null;
  endedAt: number | null;
}): string {
  if (run.goalOutcome !== null && run.goalOutcome !== 'other') {
    return `the goal was ${run.goalOutcome}`;
  }
  if (run.endedAt === null) return 'never recorded an ending, so it was cut off';
  if (run.endReason === 'interrupted') return 'interrupted';
  if (run.endReason === null || run.endReason === 'other') {
    return 'ended without recording an outcome';
  }
  return run.endReason;
}
