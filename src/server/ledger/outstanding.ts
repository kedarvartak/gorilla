import { asc, eq } from 'drizzle-orm';

import type { DatabaseHandle } from '../db/client.js';
import { runs } from '../db/schema.js';
import { acknowledgedPaths } from '../review/gate.js';
import { buildMechanicalLedger } from './mechanical.js';
import { checkReality } from './reality.js';
import { storedEntriesFor } from './store.js';
import { surprisesFor, type Surprise } from './surprises.js';

/**
 * What a card still has waiting to be acknowledged (doc 08, P4).
 *
 * The brief route assembles this inline for the interface, and the merge gate
 * reads it back over HTTP. The dispatcher cannot: it decides what to start next
 * off the request path entirely. So the rule lives here, next to the surprise
 * set it applies, and both gates ask the same question rather than each having
 * their own idea of "outstanding".
 *
 * Never throws. A card whose worktree has been removed, or whose repository
 * cannot be read, degrades to the entry-backed surprises alone - `checkReality`
 * already promises that (P7). A gate that crashed would stop the queue for a
 * reason the operator cannot act on, which is worse than the drift it looks for.
 */

export interface OutstandingInput {
  readonly database: DatabaseHandle;
  readonly cardId: string;
  /**
   * Where the card's work lives, when there is somewhere to look.
   *
   * Omitted means "entries only": without a checkout there is nothing to
   * compare the event stream against, and claiming a file changed unmentioned
   * on the strength of no evidence is exactly the assertion R10 forbids.
   */
  readonly cwd?: string | undefined;
}

export async function outstandingSurprises(input: OutstandingInput): Promise<Surprise[]> {
  const { database, cardId } = input;

  const cardRuns = database.db
    .select()
    .from(runs)
    .where(eq(runs.cardId, cardId))
    .orderBy(asc(runs.startedAt))
    .all();

  const entries = storedEntriesFor(database, cardId);

  // Mechanical entries are rebuilt only for the paths they claim: none of them
  // can be superseded and none is an assumption, so they contribute nothing to
  // the entry-backed half of the set.
  const claimedPaths = cardRuns.flatMap(
    (run) => buildMechanicalLedger({ sqlite: database.sqlite, runId: run.id }).changed,
  );

  const reality =
    input.cwd === undefined
      ? null
      : await checkReality({
          cwd: input.cwd,
          headShaAtStart: cardRuns[0]?.headShaAtStart ?? null,
          claimedPaths,
        });

  // A path stays changed-but-unmentioned however long the operator looks at it,
  // so the acknowledgement is subtracted here rather than by pretending the run
  // mentioned it.
  const seen = acknowledgedPaths(entries);

  return surprisesFor({
    cardId,
    entries,
    changedButUnmentioned: (reality?.changedButUnmentioned ?? []).filter((path) => !seen.has(path)),
  });
}
