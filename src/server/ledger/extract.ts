import type { LedgerEntry } from './entries.js';
import {
  buildPrompt,
  chooseModel,
  EXTRACTION_SYSTEM,
  type ExtractionModel,
  type ModelUsage,
} from './model.js';
import { validateEntries, type Rejection } from './validate.js';
import { buildWindow, shouldSkipModel, type ExtractionWindow, type WindowInput } from './window.js';

/**
 * The extraction pipeline (doc 08).
 *
 * Window in, validated entries out. Everything expensive or fallible is behind
 * a guard: skipped windows cost nothing, repeated windows are served from the
 * cache, an exhausted budget degrades to mechanical extraction, and a model
 * that errors degrades the same way. This function never throws, because it
 * runs off the hook response path and there is nobody there to catch it (P7).
 */

export type ExtractionOutcome =
  'extracted' | 'skipped' | 'cached' | 'budget-exhausted' | 'no-model' | 'failed';

export interface ExtractionResult {
  readonly outcome: ExtractionOutcome;
  readonly entries: readonly LedgerEntry[];
  readonly rejected: readonly Rejection[];
  readonly usage: ModelUsage;
  readonly model: string | null;
  readonly escalated: boolean;
  /** Operator-facing, and shown verbatim when the outcome is not `extracted`. */
  readonly note?: string;
}

/**
 * Token spend, tracked per card and per day (doc 08, cost control).
 *
 * Deliberately an in-memory object handed in by the caller rather than a table:
 * this card may not touch the schema, and a budget that resets on restart is
 * still a budget. Persisting it is the ledger-storage card's business.
 */
export interface TokenBudget {
  readonly limit: number;
  spent: number;
}

export function budgetRemaining(budget: TokenBudget | undefined): number {
  return budget === undefined ? Number.POSITIVE_INFINITY : Math.max(0, budget.limit - budget.spent);
}

export interface ExtractionCache {
  get(hash: string): ExtractionResult | undefined;
  set(hash: string, result: ExtractionResult): void;
}

/** Extraction results are cached by content hash, so re-extraction is free. */
export function memoryCache(): ExtractionCache {
  const store = new Map<string, ExtractionResult>();
  return {
    get: (hash) => store.get(hash),
    set: (hash, result) => void store.set(hash, result),
  };
}

export interface ExtractInput {
  readonly window: ExtractionWindow;
  /** Absent when there is no API key or the operator turned model extraction off. */
  readonly model?: ExtractionModel;
  /** The card's `synthesisModel`, used for windows that escalate. */
  readonly synthesisModel?: string | null;
  readonly fastModel?: string;
  readonly budget?: TokenBudget;
  readonly cache?: ExtractionCache;
  readonly existing?: readonly LedgerEntry[];
  readonly maxTokens?: number;
}

const EMPTY_USAGE: ModelUsage = { inputTokens: 0, outputTokens: 0 };

function nothing(outcome: ExtractionOutcome, note: string): ExtractionResult {
  return {
    outcome,
    entries: [],
    rejected: [],
    usage: EMPTY_USAGE,
    model: null,
    escalated: false,
    note,
  };
}

export async function extractWindow(input: ExtractInput): Promise<ExtractionResult> {
  const skip = shouldSkipModel(input.window);
  if (skip.skip) {
    return nothing('skipped', `Model extraction skipped: ${skip.reason ?? 'not worth a call'}.`);
  }

  const cached = input.cache?.get(input.window.hash);
  if (cached !== undefined) {
    return { ...cached, outcome: 'cached', usage: EMPTY_USAGE };
  }

  if (input.model === undefined) {
    return nothing(
      'no-model',
      'Mechanical entries only: no extraction model is configured for this board.',
    );
  }

  const choice = chooseModel({
    trigger: input.window.trigger,
    ...(input.synthesisModel === undefined ? {} : { synthesisModel: input.synthesisModel }),
    ...(input.fastModel === undefined ? {} : { fastModel: input.fastModel }),
  });

  // An estimate, since the real figure only arrives with the response. Four
  // characters per token, and the output ceiling assumed spent in full.
  const maxTokens = input.maxTokens ?? 2_000;
  const estimate = Math.ceil(input.window.text.length / 4) + maxTokens;

  if (estimate > budgetRemaining(input.budget)) {
    // Degrades and says so, rather than stopping silently (doc 08).
    return nothing(
      'budget-exhausted',
      'Mechanical entries only: this card has spent its extraction budget.',
    );
  }

  let response;
  try {
    response = await input.model({
      model: choice.model,
      system: EXTRACTION_SYSTEM,
      prompt: buildPrompt(input.window),
      maxTokens,
    });
  } catch (error) {
    return nothing('failed', `Model extraction failed: ${(error as Error).message}`);
  }

  if (input.budget !== undefined) {
    input.budget.spent += response.usage.inputTokens + response.usage.outputTokens;
  }

  const validated = validateEntries({
    window: input.window,
    raw: response.entries,
    model: choice.model,
    ...(input.existing === undefined ? {} : { existing: input.existing }),
  });

  const result: ExtractionResult = {
    outcome: 'extracted',
    entries: validated.entries,
    rejected: validated.rejected,
    usage: response.usage,
    model: choice.model,
    escalated: choice.escalated,
  };

  input.cache?.set(input.window.hash, result);
  return result;
}

/** The common path: build the window from the run's events, then extract it. */
export async function extractFromRun(
  input: WindowInput & Omit<ExtractInput, 'window'>,
): Promise<ExtractionResult & { window: ExtractionWindow }> {
  const window = buildWindow(input);
  return { ...(await extractWindow({ ...input, window })), window };
}
