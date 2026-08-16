/**
 * The entry shape shared by both halves of extraction (doc 08).
 *
 * `mechanical.ts` produces entries with no model call at all. This module adds
 * the fields only a model can supply - the rejected alternative behind a
 * decision, a confidence, the model that said it - without changing what a
 * mechanical entry is. Anything downstream (dedup, the brief) reads one type.
 */

export type LedgerKind = 'decision' | 'assumption' | 'change' | 'risk' | 'question' | 'verdict';

/**
 * Kinds a model is allowed to emit.
 *
 * `change` and `verdict` are deliberately absent: both are derivable from
 * events, so a model that emits one is restating the diff (doc 08). Excluding
 * them at the type level is the cheapest precision control in the pipeline.
 */
export const MODEL_KINDS = ['decision', 'assumption', 'risk', 'question'] as const;
export type ModelKind = (typeof MODEL_KINDS)[number];

export interface LedgerEntry {
  readonly kind: LedgerKind;
  /** One sentence, actionable by someone who was not watching. */
  readonly statement: string;
  readonly detail?: string;
  /** Required on a decision: the path not taken. A decision without one is a change. */
  readonly alternative?: string;
  readonly filePaths?: readonly string[];
  /** Event ids this was derived from. An entry with no source is never emitted. */
  readonly sourceEventIds: readonly number[];
  readonly origin: 'mechanical' | 'model';
  /** Model-reported, 0..1. Advisory - the gauntlet in validate.ts is the real gate. */
  readonly confidence?: number;
  readonly model?: string;
}

export function isModelKind(value: unknown): value is ModelKind {
  return typeof value === 'string' && (MODEL_KINDS as readonly string[]).includes(value);
}
