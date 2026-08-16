/**
 * Guardrails: the constraints a card's agent must obey (doc 05).
 *
 * The load-bearing idea is that a guardrail carries its **enforcement kind**,
 * not just its text. Some rules are hard - the launcher can express them as
 * permission modes or deny rules that Claude Code enforces. Most are
 * instructional text in a system prompt that a model may simply not follow.
 *
 * An interface that cannot tell those apart will present them identically, and
 * an operator who believes a rule is enforced when it is not will dispatch
 * unattended work on that belief. That is R10, and it is why the kind is part
 * of the stored shape rather than something inferred at render time.
 */

export type Enforcement = 'hard' | 'advisory';

export interface GuardrailSet {
  /** Paths the agent should confine itself to. Advisory: a prompt instruction. */
  readonly scope: readonly string[];
  /**
   * Things the agent must not do. Hard where the rule names a path or command
   * pattern the launcher can turn into a PreToolUse deny rule; advisory
   * otherwise.
   */
  readonly prohibit: readonly string[];
  /** Tool names to allow. Hard: passed as --allowedTools. */
  readonly allowTools: readonly string[];
  /** A command whose success the board checks itself. Hard at the gate. */
  readonly verify: string | null;
  /** Turn budget, appended to the goal condition. Advisory: the evaluator judges it. */
  readonly maxTurns: number | null;
}

export const EMPTY_GUARDRAILS: GuardrailSet = {
  scope: [],
  prohibit: [],
  allowTools: [],
  verify: null,
  maxTurns: null,
};

export interface GuardrailDescription {
  readonly kind: 'scope' | 'prohibit' | 'allowTools' | 'verify' | 'maxTurns';
  readonly text: string;
  readonly enforcement: Enforcement;
  /** Why it is or is not enforced, shown to the operator. */
  readonly because: string;
}

/**
 * A prohibition is hard only when it can be turned into something Claude Code
 * checks. In practice that means it names a path or a command prefix; a
 * sentence such as "do not over-engineer" cannot be enforced by anything.
 */
export function prohibitionIsExpressible(rule: string): boolean {
  const trimmed = rule.trim();
  if (trimmed === '') return false;

  // A path-like rule: contains a separator or a glob, and no spaces.
  if (/^[^\s]*[/*][^\s]*$/.test(trimmed)) return true;

  // A command-prefix rule such as "Bash(rm *)" or "git push".
  if (/^[A-Za-z][\w.-]*\([^)]*\)$/.test(trimmed)) return true;

  return false;
}

/** Every guardrail with its enforcement kind, for display and for the launcher. */
export function describeGuardrails(set: GuardrailSet): readonly GuardrailDescription[] {
  const described: GuardrailDescription[] = [];

  for (const path of set.scope) {
    described.push({
      kind: 'scope',
      text: `Only touch ${path}`,
      enforcement: 'advisory',
      because: 'Stated in the system prompt. Claude Code has no scope restriction to enforce.',
    });
  }

  for (const rule of set.prohibit) {
    const expressible = prohibitionIsExpressible(rule);
    described.push({
      kind: 'prohibit',
      text: `Do not ${rule}`,
      enforcement: expressible ? 'hard' : 'advisory',
      because: expressible
        ? 'Passed as a PreToolUse deny rule, which Claude Code enforces.'
        : 'Not expressible as a path or command pattern, so it is a prompt instruction only.',
    });
  }

  if (set.allowTools.length > 0) {
    described.push({
      kind: 'allowTools',
      text: `Only these tools: ${set.allowTools.join(', ')}`,
      enforcement: 'hard',
      because: 'Passed as --allowedTools at launch.',
    });
  }

  if (set.verify !== null && set.verify !== '') {
    described.push({
      kind: 'verify',
      text: `Must pass: ${set.verify}`,
      enforcement: 'hard',
      because: 'Run by the board itself, so it does not depend on the agent reporting honestly.',
    });
  }

  if (set.maxTurns !== null) {
    described.push({
      kind: 'maxTurns',
      text: `Stop after ${set.maxTurns} turns`,
      enforcement: 'advisory',
      because: 'Appended to the goal condition; the evaluator judges it from the conversation.',
    });
  }

  return described;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

/** Permissive parse. A malformed field becomes empty rather than failing the card. */
export function parseGuardrails(raw: string | null | undefined): GuardrailSet {
  if (raw === null || raw === undefined || raw.trim() === '') return EMPTY_GUARDRAILS;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return EMPTY_GUARDRAILS;
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return EMPTY_GUARDRAILS;
  }

  const record = parsed as Record<string, unknown>;
  const maxTurns = record['maxTurns'];
  const verify = record['verify'];

  return {
    scope: asStringArray(record['scope']),
    prohibit: asStringArray(record['prohibit']),
    allowTools: asStringArray(record['allowTools']),
    verify: typeof verify === 'string' && verify.trim() !== '' ? verify : null,
    maxTurns:
      typeof maxTurns === 'number' && Number.isFinite(maxTurns) && maxTurns > 0 ? maxTurns : null,
  };
}

export function serialiseGuardrails(set: GuardrailSet): string {
  return JSON.stringify(set);
}

/** Counts, for the interface header and for `doctor`. */
export function guardrailSummary(set: GuardrailSet): { hard: number; advisory: number } {
  const described = describeGuardrails(set);
  return {
    hard: described.filter((d) => d.enforcement === 'hard').length,
    advisory: described.filter((d) => d.enforcement === 'advisory').length,
  };
}
