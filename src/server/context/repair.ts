import type { GuardrailSet } from '../cards/guardrails.js';
import { describeGuardrails } from '../cards/guardrails.js';
import type { StoredEntry } from '../ledger/dedupe.js';

/**
 * Compaction repair (doc 12, output 3).
 *
 * The half of the loop that was never built. `PreCompact` extraction has worked
 * since W1: the window about to be discarded is read and turned into ledger
 * entries. But nothing was ever given back. The operator got re-synchronised and
 * the agent did not, which is the asymmetry doc 12 opens by naming.
 *
 * Compaction is not a failure to be prevented - it is how a long run continues -
 * so the answer is not to avoid it but to hand back what it took. `SessionStart`
 * fires with `source: compact` immediately afterwards, and its `additionalContext`
 * reaches the model. That was measured, not assumed (doc 14): a nonce injected
 * there came back in the agent's next answer.
 *
 * This module is pure. It is handed the card's guardrails and the entries it may
 * use, and returns text. Nothing here reads a database or decides eligibility -
 * that judgement belongs to the caller and is stated in `eligibleForRepair`.
 */

/**
 * How much repair is allowed to cost.
 *
 * A repair block that itself fills the context window defeats compaction, so
 * this is deliberately small. Characters rather than tokens because the hook
 * path must not pay for a tokenizer, and four characters to a token is close
 * enough to budget against.
 */
export const DEFAULT_REPAIR_CHARS = 2_400;

export interface RepairInput {
  readonly cardTitle: string;
  readonly guardrails: GuardrailSet;
  /** Already filtered by `eligibleForRepair`; this module does not re-check. */
  readonly entries: readonly StoredEntry[];
  readonly maxChars?: number;
}

export interface RepairBlock {
  readonly text: string;
  /** True when something was dropped to fit, so the interface can say so. */
  readonly trimmed: boolean;
  /**
   * Set when the guardrails alone exceed the ceiling.
   *
   * Doc 12 asks for this specifically: guardrails are never trimmed, so a card
   * whose rules do not fit is over-specified, and that is worth telling the
   * operator rather than silently exceeding the budget.
   */
  readonly overSpecified: boolean;
}

/**
 * Whether an entry may be re-injected into a running agent.
 *
 * The strictest rule in the product, and deliberately so. Re-injecting a stale
 * or mis-extracted claim is worse than injecting nothing, because the agent will
 * act on it - so this prefers a thin certain block to a rich speculative one.
 *
 * - A rejected entry is never eligible. The operator has said it is wrong.
 * - An entry from this run is eligible whatever its status: it is the freshest
 *   material there is, and it was extracted from the very window being repaired.
 * - An entry from an earlier run is eligible only once accepted. Unreviewed
 *   cross-run content is exactly the speculative material doc 12 excludes.
 */
export function eligibleForRepair(
  entry: StoredEntry,
  input: { runId: string | null; entryRunId: string | null },
): boolean {
  if (entry.operatorStatus === 'rejected') return false;
  if (input.runId !== null && input.entryRunId === input.runId) return true;
  return entry.operatorStatus === 'accepted' || entry.operatorStatus === 'corrected';
}

function statementOf(entry: StoredEntry): string {
  return entry.alternative === undefined
    ? entry.statement
    : `${entry.statement} (rather than ${entry.alternative})`;
}

interface Section {
  readonly heading: string;
  readonly lines: readonly string[];
  /** Guardrails are never dropped; everything else is, in the order below. */
  readonly trimmable: boolean;
}

/**
 * Assembles the block, trimming from the bottom.
 *
 * Trim order is doc 12's: guardrails first in the block and last to go, then
 * in-run decisions, then assumptions, then open questions. A question the agent
 * cannot answer alone is the least costly thing to lose, because it will simply
 * be asked again.
 */
export function buildRepairBlock(input: RepairInput): RepairBlock {
  const maxChars = input.maxChars ?? DEFAULT_REPAIR_CHARS;

  const rails = describeGuardrails(input.guardrails);
  const live = input.entries.filter(
    (entry) => entry.supersededBy === null || entry.supersededBy === undefined,
  );

  const sections: Section[] = [
    {
      heading: 'Rules for this card, which still apply',
      // The enforcement kind travels with the rule. An agent told a rule is
      // enforced when it is only advice will not treat it as its own problem.
      lines: rails.map((rail) => `- ${rail.text} (${rail.enforcement})`),
      trimmable: false,
    },
    {
      heading: 'Decided earlier in this card',
      lines: live
        .filter((entry) => entry.kind === 'decision')
        .map((entry) => `- ${statementOf(entry)}`),
      trimmable: true,
    },
    {
      heading: 'Assumed, and not since disproved',
      lines: live
        .filter((entry) => entry.kind === 'assumption')
        .map((entry) => `- ${entry.statement}`),
      trimmable: true,
    },
    {
      heading: 'Still open',
      lines: live
        .filter((entry) => entry.kind === 'question' || entry.kind === 'risk')
        .map((entry) => `- ${entry.statement}`),
      trimmable: true,
    },
  ].filter((section) => section.lines.length > 0);

  const header = [
    `Your context was just compacted. This is what you established on "${input.cardTitle}"`,
    'before that happened, recovered from the board rather than from your own memory.',
    'Treat it as established: it was recorded at the time, not reconstructed now.',
    '',
  ];

  const render = (chosen: readonly Section[]): string =>
    [...header, ...chosen.flatMap((section) => [`## ${section.heading}`, ...section.lines, ''])]
      .join('\n')
      .trimEnd();

  const fixed = sections.filter((section) => !section.trimmable);
  const overSpecified = render(fixed).length > maxChars;

  // Trimmed a line at a time from the bottom, not a section at a time. Dropping
  // a whole section to save one line would lose eleven decisions to fit a
  // twelfth, and the order already says which lines are cheapest to lose.
  //
  // Never mid-line: half a decision is a decision the agent may act on wrongly,
  // which is the failure this module exists to avoid.
  let chosen: Section[] = sections.map((section) => ({ ...section, lines: [...section.lines] }));
  let trimmed = false;

  while (render(chosen).length > maxChars) {
    const target = [...chosen].reverse().find((section) => section.trimmable);
    if (target === undefined) break;

    trimmed = true;
    const kept = target.lines.slice(0, -1);

    chosen = chosen
      .map((section) => (section === target ? { ...section, lines: kept } : section))
      .filter((section) => section.lines.length > 0);
  }

  return { text: render(chosen), trimmed, overSpecified };
}

/** True when there is nothing worth saying, so the board stays quiet. */
export function repairIsEmpty(block: RepairBlock): boolean {
  return !block.text.includes('##');
}
