/**
 * What the operator is about to accept (T37).
 *
 * The gate refuses a merge while something is unjudged, which is the right
 * refusal and only half a review. When it lets the merge through, nothing
 * assembles what the run established, what the board checked, and what it
 * could not check - so accepting is a click rather than a decision, and doc
 * 01's whole complaint is that merging without understanding is the failure
 * this product exists to prevent.
 *
 * Nothing here is new information. It is the pieces the card already holds,
 * put in one place and phrased as things to have looked at.
 */

export type CheckState =
  /** Nothing here needs the operator. */
  | 'settled'
  /** Something the operator has to look at before this is a decision. */
  | 'needs-you'
  /**
   * The board could not check. Never presented as settled: an unrun check and
   * a passed one are the two things this document exists to keep apart.
   */
  | 'unknown';

export interface Check {
  readonly name: string;
  readonly state: CheckState;
  readonly detail: string;
}

export interface ReadinessInput {
  readonly verify: { readonly status: string } | null;
  readonly verifyCommand: string | null;
  readonly outstanding: number;
  readonly establishedCount: number;
  readonly diff: { readonly readable: boolean; readonly files: readonly unknown[] } | undefined;
  readonly mergeForecast: { readonly readable: boolean; readonly clean: boolean } | undefined;
  readonly blockers: readonly unknown[];
  readonly claimedNotInGit: readonly string[];
}

export interface Readiness {
  readonly checks: readonly Check[];
  /** True when nothing on the list needs the operator. Not a recommendation. */
  readonly settled: boolean;
}

export function assessReadiness(input: ReadinessInput): Readiness {
  const checks: Check[] = [];

  // The verify is first because it is the only thing here the board did
  // itself rather than read from what the agent said.
  if (input.verifyCommand === null) {
    checks.push({
      name: 'verify',
      state: 'unknown',
      detail: 'This card has no verify command, so nothing was checked by the board.',
    });
  } else if (input.verify === null) {
    checks.push({
      name: 'verify',
      state: 'unknown',
      detail: `\`${input.verifyCommand}\` has not been run against this branch.`,
    });
  } else {
    checks.push({
      name: 'verify',
      state: input.verify.status === 'passed' ? 'settled' : 'needs-you',
      detail: `\`${input.verifyCommand}\` ${input.verify.status}.`,
    });
  }

  checks.push({
    name: 'judgements',
    state: input.outstanding === 0 ? 'settled' : 'needs-you',
    detail:
      input.outstanding === 0
        ? 'Nothing is waiting on your verdict.'
        : `${String(input.outstanding)} thing(s) the run surprised the board with are unjudged. The gate holds the merge until they are.`,
  });

  checks.push({
    name: 'established',
    // Never 'needs-you': having read the ledger is not something the board can
    // observe, and a checklist that claimed to know would be asserting it.
    state: 'settled',
    detail:
      input.establishedCount === 0
        ? 'The run established nothing you have accepted. Either it was uneventful or nothing has been read.'
        : `${String(input.establishedCount)} thing(s) you have accepted are recorded on this card.`,
  });

  if (input.diff === undefined || !input.diff.readable) {
    checks.push({
      name: 'diff',
      state: 'unknown',
      detail: 'The branch could not be read, so there is no diff to look at.',
    });
  } else {
    checks.push({
      name: 'diff',
      state: 'settled',
      detail: `${String(input.diff.files.length)} file(s) changed.`,
    });
  }

  if (input.mergeForecast !== undefined && input.mergeForecast.readable) {
    checks.push({
      name: 'conflicts',
      state: input.mergeForecast.clean ? 'settled' : 'needs-you',
      detail: input.mergeForecast.clean
        ? 'This would merge cleanly.'
        : 'This would conflict. Resolving is part of merging, not a reason not to.',
    });
  }

  if (input.blockers.length > 0) {
    checks.push({
      name: 'dependencies',
      state: 'needs-you',
      detail: `${String(input.blockers.length)} card(s) this one depends on are not done.`,
    });
  }

  if (input.claimedNotInGit.length > 0) {
    checks.push({
      name: 'claims',
      state: 'needs-you',
      detail: `${String(input.claimedNotInGit.length)} path(s) the run mentioned are not in the branch. Often innocent, worth one look.`,
    });
  }

  return {
    checks,
    // Unknown does not count as settled. That distinction is the entire point:
    // a card whose verify never ran is not a card that passed.
    settled: checks.every((check) => check.state === 'settled'),
  };
}
