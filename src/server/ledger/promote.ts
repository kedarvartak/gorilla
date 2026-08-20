import type { GuardrailSet } from '../cards/guardrails.js';
import { prohibitionIsExpressible } from '../cards/guardrails.js';
import type { StoredEntry } from './dedupe.js';

/**
 * Turning a judged entry into a rule (doc 12, output 1).
 *
 * This is what makes judgement compound. Today an accepted assumption reaches
 * the next run as context and then evaporates: the agent is told about it, and
 * nothing stops it doing otherwise. A guardrail is the same knowledge in a form
 * that constrains - written into the launch settings as a deny rule where it can
 * be, and into the prompt where it cannot.
 *
 * The distinction that has to survive is which of those happened. An operator
 * who promotes "never touch the schema" and is shown an enforced rule when the
 * board could only manage prompt text has been told a protection exists that
 * does not (R10). So promotion reports what it produced, not what was asked for.
 */

export type PromotionTarget = 'scope' | 'prohibit' | 'verify';

export interface PromotionRequest {
  readonly entry: StoredEntry;
  readonly target: PromotionTarget;
  /**
   * The rule to add, which is usually not the statement itself.
   *
   * "The exporter is only called from the CLI" is a true assumption and a
   * useless prohibition. Promotion is a judgement about what the rule should
   * say, so the operator supplies it and the entry supplies the provenance.
   */
  readonly rule: string;
}

export interface PromotionResult {
  readonly guardrails: GuardrailSet;
  /** What the board can actually do about it, decided here rather than implied. */
  readonly enforcement: 'hard' | 'advisory';
  readonly detail: string;
}

export class PromotionError extends Error {
  constructor(
    message: string,
    readonly field: string,
  ) {
    super(message);
    this.name = 'PromotionError';
  }
}

/**
 * Adds the rule to the card's guardrails.
 *
 * Refuses an entry that is not the operator's to promote. An unreviewed entry is
 * a model's claim, and turning one into a rule without a human reading it would
 * make the ledger able to constrain the agent by itself - which is the one thing
 * doc 12 is careful never to allow.
 */
export function promoteToGuardrail(
  current: GuardrailSet,
  request: PromotionRequest,
): PromotionResult {
  const rule = request.rule.trim();

  if (rule === '') {
    throw new PromotionError('A promoted rule needs something to say.', 'rule');
  }

  if (request.entry.operatorStatus !== 'accepted' && request.entry.operatorStatus !== 'corrected') {
    throw new PromotionError(
      'Only an entry you have accepted can become a rule. An unreviewed entry is the ' +
        "model's claim, not yours.",
      'entry',
    );
  }

  if (request.entry.promotedTo !== null && request.entry.promotedTo !== undefined) {
    throw new PromotionError(
      `This entry is already the ${request.entry.promotedTo} rule "${request.entry.promotedTo}".`,
      'entry',
    );
  }

  switch (request.target) {
    case 'verify': {
      // One verify per card: it is the command the board runs, and two would
      // mean the board silently choosing which one counts.
      return {
        guardrails: { ...current, verify: rule },
        enforcement: 'hard',
        detail:
          current.verify === null
            ? `The board will run \`${rule}\` after every run of this card.`
            : `Replaced the previous verify command, \`${current.verify}\`.`,
      };
    }

    case 'prohibit': {
      if (current.prohibit.includes(rule)) {
        throw new PromotionError('That rule is already on this card.', 'rule');
      }

      // Asked, not assumed. A prohibition naming a path or a command pattern
      // becomes a deny rule Claude Code enforces; one phrased as advice is
      // prompt text, and the operator has to be told which they just got.
      const expressible = prohibitionIsExpressible(rule);

      return {
        guardrails: { ...current, prohibit: [...current.prohibit, rule] },
        enforcement: expressible ? 'hard' : 'advisory',
        detail: expressible
          ? 'Written into the launch settings as a deny rule: the agent cannot do this.'
          : 'Added as prompt text. It names no path or command pattern, so it rests on ' +
            'the agent cooperating rather than on anything stopping it.',
      };
    }

    default: {
      if (current.scope.includes(rule)) {
        throw new PromotionError('That path is already in scope.', 'rule');
      }

      return {
        guardrails: { ...current, scope: [...current.scope, rule] },
        enforcement: 'advisory',
        detail:
          'Scope is advisory: it tells the agent where to work and does not stop it ' +
          'working elsewhere.',
      };
    }
  }
}

/**
 * A rule the operator might mean, offered as a starting point.
 *
 * Only ever a suggestion. The statement is a description of what happened and
 * the rule is an instruction about what may happen next, and only a person can
 * make that leap - so this fills the box and expects to be edited.
 */
export function suggestRule(entry: StoredEntry, target: PromotionTarget): string {
  if (target === 'verify') return '';

  const paths = entry.filePaths ?? [];
  if (target === 'scope') return paths.join(', ');

  // A prohibition about specific files is the case the board can actually
  // enforce, so it is the one worth pre-filling.
  return paths.length === 1 ? (paths[0] ?? '') : '';
}
