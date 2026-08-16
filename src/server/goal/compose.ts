import type { GuardrailSet } from '../cards/guardrails.js';

/**
 * Composing and checking `/goal` conditions (doc 07 section 4).
 *
 * The whole reason this module exists is one property of the evaluator that is
 * easy to forget and expensive to forget: **it does not call tools**. It sees
 * only what the agent surfaced in the conversation. "All tests pass" resolves
 * because the agent runs the tests and the output lands in the transcript;
 * "the code is clean" never resolves, because nothing can demonstrate it.
 *
 * Most disappointment with `/goal` traces to conditions the evaluator
 * structurally cannot assess, so the board warns rather than letting the
 * operator find out after forty minutes.
 */

/** Claude Code's documented cap. */
export const MAX_CONDITION_LENGTH = 4_000;

export type WarningCode =
  'no-verifiable-check' | 'too-long' | 'no-bound' | 'empty' | 'asks-for-judgement';

export interface GoalWarning {
  readonly code: WarningCode;
  readonly message: string;
  /** What the operator should do about it. */
  readonly remedy: string;
  readonly severity: 'error' | 'warning';
}

export interface ComposeInput {
  /** The measurable end state, in the operator's words. */
  readonly endState: string;
  /** A command whose output will appear in the conversation. */
  readonly verify?: string | null;
  readonly guardrails?: GuardrailSet | null;
  readonly maxTurns?: number | null;
}

/**
 * Phrases that describe a quality rather than an observable state. An evaluator
 * reading the conversation cannot settle any of them, so a condition resting on
 * one will run until it hits its turn bound.
 */
const JUDGEMENT_PHRASES = [
  'clean',
  'idiomatic',
  'well written',
  'well-written',
  'readable',
  'elegant',
  'production ready',
  'production-ready',
  'good quality',
  'high quality',
  'properly',
  'correctly',
  'nicely',
  'sensible',
  'reasonable',
  'maintainable',
];

/**
 * Signals that the condition names something whose result appears in the
 * conversation. Deliberately generous: a false "no check" warning on a fine
 * condition trains the operator to ignore warnings.
 */
const CHECK_SIGNALS = [
  /\b(npm|pnpm|yarn|bun|make|cargo|go|python3?|pytest|jest|vitest|tsc|eslint|git)\b/i,
  /\bexits? (with )?(code )?0\b/i,
  /\b(passes?|passing|succeeds?|green)\b/i,
  /\bno (errors?|failures?|warnings?)\b/i,
  /\breturns? \d{3}\b/i,
  /`[^`]+`/,
];

export function hasVerifiableCheck(condition: string): boolean {
  return CHECK_SIGNALS.some((pattern) => pattern.test(condition));
}

export function hasBound(condition: string): boolean {
  return /\b(stop after|within|no more than|at most|by turn)\b/i.test(condition);
}

export function judgementPhrasesIn(condition: string): string[] {
  const lowered = condition.toLowerCase();
  return JUDGEMENT_PHRASES.filter((phrase) => lowered.includes(phrase));
}

/**
 * Composes the condition in the doc 07 section 4 structure:
 * measurable end state, stated check, constraints, bound.
 */
export function composeCondition(input: ComposeInput): string {
  const parts: string[] = [input.endState.trim().replace(/[.\s]+$/, '')];

  const verify = input.verify?.trim();
  if (verify !== undefined && verify !== '') {
    parts.push(`verified by running \`${verify}\` and showing its output`);
  }

  const prohibitions = input.guardrails?.prohibit ?? [];
  if (prohibitions.length > 0) {
    parts.push(`without modifying ${prohibitions.join(' or ')}`);
  }

  const scope = input.guardrails?.scope ?? [];
  if (scope.length > 0) {
    parts.push(`changing only ${scope.join(' and ')}`);
  }

  let condition = parts.join(', ');

  const bound = input.maxTurns ?? input.guardrails?.maxTurns ?? null;
  if (bound !== null) {
    condition += `. Report progress against this each turn, and stop after ${bound} turns if it is not met`;
  }

  return `${condition}.`;
}

/**
 * Warns; never rewrites. Silently correcting what the operator typed would
 * leave them believing the agent is working toward something it is not.
 */
export function checkCondition(condition: string): GoalWarning[] {
  const warnings: GoalWarning[] = [];
  const trimmed = condition.trim();

  if (trimmed === '') {
    return [
      {
        code: 'empty',
        message: 'The goal condition is empty.',
        remedy: 'Describe the end state the agent should reach.',
        severity: 'error',
      },
    ];
  }

  if (trimmed.length > MAX_CONDITION_LENGTH) {
    warnings.push({
      code: 'too-long',
      message: `The condition is ${trimmed.length} characters; Claude Code caps it at ${MAX_CONDITION_LENGTH}.`,
      remedy: 'Move the detail into the card body and keep the condition to the end state.',
      severity: 'error',
    });
  }

  if (!hasVerifiableCheck(trimmed)) {
    warnings.push({
      code: 'no-verifiable-check',
      message:
        'No check the evaluator could read. It does not run commands - it only sees what the agent surfaced in the conversation.',
      remedy: 'Name a command whose output will appear, such as "`npm test` exits 0".',
      severity: 'warning',
    });
  }

  if (!hasBound(trimmed)) {
    warnings.push({
      code: 'no-bound',
      message: 'No turn or time bound, so this goal can run indefinitely.',
      remedy: 'Add a clause such as "or stop after 20 turns".',
      severity: 'warning',
    });
  }

  const judgement = judgementPhrasesIn(trimmed);
  if (judgement.length > 0) {
    warnings.push({
      code: 'asks-for-judgement',
      message: `Asks for a quality the evaluator cannot settle: ${judgement.join(', ')}.`,
      remedy: 'Replace it with something observable, or move it to the card body as guidance.',
      severity: 'warning',
    });
  }

  return warnings;
}

export interface ComposedGoal {
  readonly condition: string;
  readonly warnings: readonly GoalWarning[];
  readonly length: number;
  /** False when a warning of severity error is present. */
  readonly usable: boolean;
}

export function composeAndCheck(input: ComposeInput): ComposedGoal {
  const condition = composeCondition(input);
  const warnings = checkCondition(condition);

  return {
    condition,
    warnings,
    length: condition.length,
    usable: !warnings.some((warning) => warning.severity === 'error'),
  };
}
