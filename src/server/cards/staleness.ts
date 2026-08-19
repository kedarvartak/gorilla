import { existsSync } from 'node:fs';

import { simpleGit } from 'simple-git';

import type { GuardrailSet } from './guardrails.js';

/**
 * Whether a card still describes work that needs doing (doc 05).
 *
 * Found by losing three cards to it in one batch. Of six cards left on the
 * board, two described modules that had shipped weeks earlier and one duplicated
 * an endpoint another card had already built. Dispatching any of them would have
 * spent a run rebuilding what existed and produced a merge conflict as its only
 * output.
 *
 * The board could not see it, and that is the same comprehension failure the
 * product exists to fix - pointed at the backlog instead of at the code. A card
 * is written at a moment, and the repository moves underneath it. Nothing was
 * watching for the gap.
 *
 * This is deliberately a *suspicion*, never a verdict. It reads cheap signals
 * and reports what it found, because the alternative - a board that quietly
 * archives cards it believes are finished - would eventually archive one that
 * was not, and an operator who has been burned that way stops trusting the
 * whole surface. The operator decides; this only makes the question visible.
 */

export type StaleSignal =
  // Every path the card names already exists, and the card has never run.
  | 'targets-exist'
  // The card's verify command is named by a card that has already merged.
  | 'duplicate-verify'
  // Another card that has merged names the same files.
  | 'overlaps-merged';

export interface StaleFinding {
  readonly signal: StaleSignal;
  /** One line, in the operator's terms. Never "stale", always why. */
  readonly detail: string;
  /** What to look at, so the suspicion can be checked rather than believed. */
  readonly evidence: readonly string[];
}

export interface StaleVerdict {
  readonly suspect: boolean;
  readonly findings: readonly StaleFinding[];
  /** What the operator should do about it, when there is anything to do. */
  readonly advice: string | null;
}

/**
 * Paths a card names, from its scope and its body.
 *
 * A card that says which files it will touch has told us where to look. One that
 * does not is simply not a candidate for this check - absence of a signal is not
 * a signal, and guessing from prose would produce the false positives this whole
 * module is shaped to avoid.
 */
export function claimedPaths(input: { guardrails: GuardrailSet; body: string }): string[] {
  const fromScope = input.guardrails.scope.filter(
    (entry) => entry.includes('/') || entry.includes('.'),
  );

  // Anything that reads like a source path in the body. Deliberately narrow: an
  // extension and a separator, so prose about "the ledger" is not mistaken for
  // a file. Backticks are the usual way these get written.
  const fromBody = [...input.body.matchAll(/`?((?:[\w.-]+\/)+[\w.-]+\.[a-z]{2,4})`?/g)].map(
    (match) => match[1] ?? '',
  );

  return [...new Set([...fromScope, ...fromBody])].filter((path) => path !== '');
}

export interface StalenessInput {
  readonly cardTitle: string;
  readonly body: string;
  readonly guardrails: GuardrailSet;
  /** Runs this card has had. A card that has run is explained by its own history. */
  readonly runCount: number;
  readonly repoCwd: string;
  /** Merged cards, so work that landed elsewhere can be recognised. */
  readonly merged: readonly { title: string; verify: string | null; paths: readonly string[] }[];
}

/**
 * Looks for reasons to doubt that a card is still work.
 *
 * Every signal here is cheap and local: file existence and a comparison against
 * cards that have already merged. Nothing calls a model, because a suspicion
 * worth raising has to be worth raising on every card on every board load, and
 * because a model asked "is this done?" will confidently answer either way.
 *
 * Synchronous on purpose. The only asynchronous part is finding out what a
 * merged card changed, which the caller does once per merged card in
 * `mergedPaths`; the judgement itself is arithmetic over what it is handed.
 */
export function assessStaleness(input: StalenessInput): StaleVerdict {
  // A card that has run is not stale, it is in progress or finished, and its own
  // history explains it better than any inference here could.
  if (input.runCount > 0) return { suspect: false, findings: [], advice: null };

  const findings: StaleFinding[] = [];
  const paths = claimedPaths(input);

  if (paths.length > 0 && existsSync(input.repoCwd)) {
    const present = paths.filter((path) => existsSync(`${input.repoCwd}/${path}`));

    // Every file it names already exists and it has never run. Not proof - a
    // card can legitimately edit existing files - but it is the exact shape the
    // three lost cards had, and it costs nothing to ask.
    if (present.length === paths.length) {
      findings.push({
        signal: 'targets-exist',
        detail:
          `Every file this card names already exists, and the card has never run. ` +
          'If the work landed another way, the card is describing something finished.',
        evidence: present,
      });
    }
  }

  const verify = input.guardrails.verify;
  if (verify !== null && verify.trim() !== '') {
    const sharing = input.merged.filter((card) => card.verify === verify);
    if (sharing.length > 0) {
      findings.push({
        signal: 'duplicate-verify',
        detail:
          `${String(sharing.length)} merged card(s) prove themselves with the same command. ` +
          'That is normal on a shared suite, and worth a glance when the titles are close.',
        evidence: sharing.map((card) => card.title),
      });
    }
  }

  const overlapping = input.merged.filter((card) =>
    card.paths.some((path) => paths.includes(path)),
  );

  if (overlapping.length > 0) {
    findings.push({
      signal: 'overlaps-merged',
      detail:
        `A merged card already changed the same file(s). This card may be describing ` +
        'work that has since landed, or may conflict with it.',
      evidence: overlapping.map((card) => card.title),
    });
  }

  // `targets-exist` alone is the reliable one. The other two are context that
  // sharpens it rather than raising an alarm on their own - a shared verify
  // command is the normal state of a project with one test suite, and flagging
  // every card for it would train the operator to ignore the flag.
  const suspect = findings.some((finding) => finding.signal === 'targets-exist');

  return {
    suspect,
    findings,
    advice: suspect
      ? 'Read the card against what is on disk before dispatching it. If the work is done, ' +
        'mark it done; if it is now a smaller slice, rewrite the goal to say so.'
      : null,
  };
}

/** Files a merged card actually changed, for comparison. Cheap: one git call. */
export async function mergedPaths(repoCwd: string, branch: string | null): Promise<string[]> {
  if (branch === null || !existsSync(repoCwd)) return [];

  try {
    // Against the merge base, so this is the card's own work rather than
    // everything that has happened on the target since.
    const raw = await simpleGit(repoCwd).raw(['diff', '--name-only', `HEAD...${branch}`]);
    return raw.split('\n').filter((line) => line.trim() !== '');
  } catch {
    // A deleted branch is the normal end state of a merged card, so this is an
    // expected miss rather than a failure.
    return [];
  }
}
