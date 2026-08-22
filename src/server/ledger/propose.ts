import { prohibitionIsExpressible, type GuardrailSet } from '../cards/guardrails.js';
import type { StoredEntry } from './dedupe.js';
import type { PromotionTarget } from './promote.js';

/**
 * Proposing a rule from what the runs established (T14).
 *
 * Doc 12's first output is that judgement compounds: an accepted entry becomes
 * a rule that constrains the next run. The machinery for that has existed
 * since G1 and has one caller - a human who happens to remember the entry is
 * there. In practice nothing has ever been promoted, because promotion
 * requires the operator to go looking for candidates among everything the
 * ledger ever recorded.
 *
 * So this looks for them. It proposes and never applies: an entry becoming a
 * rule without a human reading it would let the ledger constrain the agent by
 * itself, which is the one thing doc 12 is careful never to allow. A proposal
 * is a shortlist with a suggested wording, and the operator still says yes.
 */

export interface GuardrailProposal {
  readonly entryId: string;
  readonly statement: string;
  readonly target: PromotionTarget;
  /** Suggested wording. The operator edits it; promotion takes what they send. */
  readonly rule: string;
  /**
   * What the board could actually do with this rule if promoted.
   *
   * Decided here rather than at promotion time so the shortlist cannot imply
   * an enforcement it will not get. An operator who reads "prohibit" and
   * receives prompt text has been told a protection exists that does not.
   */
  readonly enforcement: 'hard' | 'advisory';
  /** Why this entry looks like a rule, in the operator's terms. */
  readonly why: string;
}

/** Statements that read as a standing prohibition rather than a one-off note. */
const PROHIBITION = /\b(never|must not|do not|don'?t|should not|avoid)\b/i;

/** Statements that read as a check rather than a constraint. */
const VERIFICATION = /\b(must pass|has to pass|always run|verified by|verify with)\b/i;

function ruleFor(entry: StoredEntry, target: PromotionTarget): string {
  // A prohibition backed by file paths becomes the paths, because those are
  // the form the settings overlay can actually enforce. Everything else keeps
  // the statement's own words: inventing a rule the operator did not write is
  // how a promotion ends up saying something nobody agreed to.
  if (target === 'prohibit' && entry.filePaths !== undefined && entry.filePaths.length > 0) {
    return entry.filePaths.join(', ');
  }
  return entry.statement.trim();
}

/** Statements that fence work in rather than out. */
const SCOPE = /\b(only ever|only in|confined to|stays? within|limited to)\b/i;

/**
 * What kind of rule the statement is asking to become, or null.
 *
 * Read from the wording rather than from the entry's kind. There is no
 * `constraint` kind - a rule arrives as an accepted assumption or decision
 * phrased like one - so proposing by kind would shortlist every assumption the
 * ledger ever held, which is a list nobody reads and therefore no shortlist.
 */
function targetFor(entry: StoredEntry): PromotionTarget | null {
  if (VERIFICATION.test(entry.statement)) return 'verify';
  if (PROHIBITION.test(entry.statement)) return 'prohibit';
  if (SCOPE.test(entry.statement)) return 'scope';
  return null;
}

function alreadySaid(current: GuardrailSet, rule: string): boolean {
  const normalised = rule.trim().toLowerCase();
  return [...current.prohibit, ...current.scope, current.verify ?? ''].some(
    (existing) => existing.trim().toLowerCase() === normalised,
  );
}

/**
 * The shortlist, most enforceable first.
 *
 * A rule the board can write into the settings overlay outranks one it can
 * only put in the prompt, because the operator's time is better spent on the
 * promotions that will actually stop something.
 */
export function proposeGuardrails(
  entries: readonly StoredEntry[],
  current: GuardrailSet,
): GuardrailProposal[] {
  const proposals: GuardrailProposal[] = [];

  for (const entry of entries) {
    // Only what the operator has already agreed with. An unreviewed entry is
    // the model's claim, and shortlisting it would invite promoting a rule
    // nobody has read.
    if (entry.operatorStatus !== 'accepted' && entry.operatorStatus !== 'corrected') continue;
    if (entry.promotedTo !== null && entry.promotedTo !== undefined) continue;

    const target = targetFor(entry);
    if (target === null) continue;

    const rule = ruleFor(entry, target);
    if (rule === '' || alreadySaid(current, rule)) continue;

    const enforcement =
      target === 'prohibit' && prohibitionIsExpressible(rule) ? 'hard' : 'advisory';

    proposals.push({
      entryId: entry.id,
      statement: entry.statement,
      target,
      rule,
      enforcement,
      why:
        enforcement === 'hard'
          ? 'You accepted this, and it is expressible as a deny rule the board can enforce.'
          : `You accepted this, and it reads as a standing rule. The board can only pass it to the agent as text, so it constrains by persuasion.`,
    });
  }

  return proposals.sort((left, right) =>
    left.enforcement === right.enforcement ? 0 : left.enforcement === 'hard' ? -1 : 1,
  );
}
