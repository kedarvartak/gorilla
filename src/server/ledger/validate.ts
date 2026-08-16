import { isModelKind, type LedgerEntry } from './entries.js';
import type { RawEntry } from './model.js';
import type { ExtractionWindow } from './window.js';

/**
 * The gauntlet between the model and the ledger (doc 08, Evaluation).
 *
 * Precision is the metric that decides whether this product works: an operator
 * who learns the ledger contains filler starts skimming it, and skimming is the
 * original failure mode returning. Omission costs one missed item; noise costs
 * the habit of reading.
 *
 * So the rules here are deliberately asymmetric. Every one of them discards on
 * doubt, and every discard records why, because a filter you cannot interrogate
 * is a filter nobody will tune.
 */

export interface Rejection {
  readonly rule: string;
  readonly reason: string;
  readonly statement: string;
}

export interface ValidationResult {
  readonly entries: readonly LedgerEntry[];
  readonly rejected: readonly Rejection[];
}

export interface ValidateInput {
  readonly window: ExtractionWindow;
  readonly raw: readonly RawEntry[];
  readonly model?: string;
  /** Entries already on this card, so a repeat of an old statement is not re-emitted. */
  readonly existing?: readonly LedgerEntry[];
}

/** A statement below this is a label, not a statement someone could act on. */
const MIN_STATEMENT_CHARS = 25;
/** Above this it is a paragraph, and doc 08 asks for one sentence. */
const MAX_STATEMENT_CHARS = 320;

/**
 * Restating the diff. The event log already says which files changed, with
 * exact counts; a model sentence saying the same thing adds nothing and takes
 * a slot in a bounded list.
 */
const DIFF_RESTATEMENT =
  /\b(was|were|has been|have been)\s+(modified|edited|updated|created|written|changed|added|deleted|removed)\b|^\s*(edited|modified|updated|created|wrote|added|deleted)\s+\S+\.(ts|tsx|js|jsx|json|md|sql|py|go|rs)\b/i;

/**
 * Filler. These are the shapes a small model falls into when it has been asked
 * for entries and has none: narration of effort rather than of content.
 */
const FILLER = [
  /\bthe agent (continued|proceeded|worked|kept|went on|began|started)\b/i,
  /\bmade (good )?progress\b/i,
  /\bvarious (changes|files|updates|improvements)\b/i,
  /\b(no|without) (issues|problems|errors) (were |was )?(encountered|found|reported)\b/i,
  /\bsuccessfully (completed|finished|implemented|ran)\b/i,
  /\bas (expected|part of the task)\b/i,
  /\bwork (is )?(ongoing|in progress|continues)\b/i,
  /\b(this|the) (turn|session|run) (was|is) (mechanical|routine|uneventful)\b/i,
];

/** Near-duplicate threshold on content-word overlap. Cheap by design: embeddings
 *  belong to the dedup and supersession card, not to this one. */
const JACCARD_THRESHOLD = 0.8;

const STOPWORDS = new Set([
  'the',
  'a',
  'an',
  'to',
  'of',
  'in',
  'on',
  'for',
  'and',
  'or',
  'is',
  'was',
  'were',
  'be',
  'been',
  'it',
  'that',
  'this',
  'with',
  'as',
  'by',
  'at',
  'from',
  'has',
  'have',
  'will',
  'not',
]);

function contentWords(statement: string): Set<string> {
  return new Set(
    statement
      .toLowerCase()
      .replace(/[^a-z0-9\s./_-]/g, ' ')
      .split(/\s+/)
      .filter((word) => word !== '' && !STOPWORDS.has(word)),
  );
}

function jaccard(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const word of left) if (right.has(word)) shared += 1;
  return shared / (left.size + right.size - shared);
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function sentenceCount(statement: string): number {
  return statement.split(/[.!?]+(?:\s|$)/).filter((part) => part.trim() !== '').length;
}

/**
 * One entry through every rule, in order. The first rule that fires wins, so
 * the reported reason is the most fundamental one rather than the last checked.
 */
function screen(
  raw: RawEntry,
  window: ExtractionWindow,
  model: string | undefined,
): { entry: LedgerEntry } | { rejection: Rejection } {
  const statement = asString(raw.statement) ?? '';
  const reject = (rule: string, reason: string): { rejection: Rejection } => ({
    rejection: { rule, reason, statement: statement || '(no statement)' },
  });

  if (statement === '') return reject('shape', 'the entry carries no statement');

  if (!isModelKind(raw.kind)) {
    return reject(
      'kind',
      // A model-emitted `change` is the diff restated; mechanical.ts owns those.
      `${String(raw.kind)} is not a kind the model may emit`,
    );
  }

  if (statement.length < MIN_STATEMENT_CHARS) {
    return reject('too-short', 'too short to act on');
  }
  if (statement.length > MAX_STATEMENT_CHARS || sentenceCount(statement) > 2) {
    return reject('too-long', 'more than one sentence, so it is a summary not a statement');
  }

  for (const pattern of FILLER) {
    if (pattern.test(statement)) return reject('filler', 'narrates effort rather than content');
  }

  if (DIFF_RESTATEMENT.test(statement)) {
    return reject('diff-restatement', 'restates a file change already recorded mechanically');
  }

  const alternative = asString(raw.alternative);
  if (raw.kind === 'decision' && alternative === null) {
    // Doc 08: a decision with no rejected alternative is a change, and change
    // entries come from events. Retyping it here would launder it, so it goes.
    return reject('no-alternative', 'a decision must name the path not taken');
  }

  const cited = Array.isArray(raw.sourceEventIds)
    ? raw.sourceEventIds.filter((id): id is number => typeof id === 'number')
    : [];
  const resolved = cited.filter((id) => window.eventIds.includes(id));

  if (resolved.length === 0) {
    // "Entries whose sources cannot be resolved are discarded rather than
    // shown, because an unfalsifiable claim in the ledger is worse than a gap."
    return reject(
      'unresolved-source',
      cited.length === 0 ? 'cites no event' : 'cites no event in this window',
    );
  }

  const confidence = typeof raw.confidence === 'number' ? raw.confidence : undefined;

  const detail = asString(raw.detail);

  return {
    entry: {
      kind: raw.kind,
      statement,
      // Spread rather than assign undefined: exactOptionalPropertyTypes draws
      // a distinction between "absent" and "present and undefined", and the
      // entry shape means absent.
      ...(detail === null ? {} : { detail }),
      ...(alternative === null || alternative === undefined ? {} : { alternative }),
      filePaths: asStringArray(raw.filePaths),
      sourceEventIds: resolved,
      origin: 'model',
      ...(confidence === undefined ? {} : { confidence }),
      ...(model === undefined ? {} : { model }),
    },
  };
}

/**
 * Validates a model response into entries fit for the ledger.
 *
 * Duplicates are folded rather than dropped: a statement the model repeats is
 * the same claim with more evidence behind it, so the source ids merge onto the
 * survivor. That is the same rule doc 08 gives for cross-window duplicates, and
 * applying it within a window too keeps the two paths consistent.
 */
export function validateEntries(input: ValidateInput): ValidationResult {
  const entries: LedgerEntry[] = [];
  const rejected: Rejection[] = [];
  const fingerprints: Set<string>[] = [];

  const existing = (input.existing ?? []).map((entry) => contentWords(entry.statement));

  for (const raw of input.raw) {
    const screened = screen(raw, input.window, input.model);
    if ('rejection' in screened) {
      rejected.push(screened.rejection);
      continue;
    }

    const words = contentWords(screened.entry.statement);

    const priorIndex = fingerprints.findIndex((seen) => jaccard(seen, words) >= JACCARD_THRESHOLD);
    if (priorIndex >= 0) {
      const prior = entries[priorIndex];
      if (prior !== undefined) {
        entries[priorIndex] = {
          ...prior,
          sourceEventIds: [
            ...new Set([...prior.sourceEventIds, ...screened.entry.sourceEventIds]),
          ].sort((a, b) => a - b),
        };
      }
      rejected.push({
        rule: 'duplicate',
        reason: 'already stated in this window; its sources were merged',
        statement: screened.entry.statement,
      });
      continue;
    }

    if (existing.some((seen) => jaccard(seen, words) >= JACCARD_THRESHOLD)) {
      rejected.push({
        rule: 'already-known',
        reason: 'already on this card from an earlier window',
        statement: screened.entry.statement,
      });
      continue;
    }

    entries.push(screened.entry);
    fingerprints.push(words);
  }

  return { entries, rejected };
}
