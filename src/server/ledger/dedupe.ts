import type { LedgerEntry } from './entries.js';

/**
 * Deduplication and supersession (doc 08).
 *
 * Extraction windows overlap and long runs revisit topics, so the same
 * statement arrives repeatedly. Three outcomes, and the third is the valuable
 * one:
 *
 * - Near-identical to an existing entry: discarded, and its sources are folded
 *   into the entry it duplicates, which raises that entry's evidence.
 * - Contradicts an existing entry: the old one is marked superseded and kept.
 *   "This was decided, then reversed" is frequently the most informative thing
 *   in a long run, and deleting the earlier entry destroys it.
 * - Otherwise: inserted.
 *
 * Similarity is lexical, not embedded. A model call per comparison would cost
 * more than the extraction it is filtering, and the failure mode of getting it
 * slightly wrong is a duplicate line rather than a wrong claim.
 */

export interface StoredEntry extends LedgerEntry {
  readonly id: string;
  readonly supersededBy?: string | null;
}

export type MergeAction = 'inserted' | 'duplicate' | 'supersedes';

export interface MergeDecision {
  readonly action: MergeAction;
  readonly entry: LedgerEntry;
  /** The existing entry this duplicates or reverses. */
  readonly relatedId?: string;
  readonly why: string;
}

const STOPWORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'been',
  'but',
  'by',
  'for',
  'from',
  'has',
  'have',
  'in',
  'is',
  'it',
  'its',
  'not',
  'of',
  'on',
  'or',
  'that',
  'the',
  'this',
  'to',
  'was',
  'were',
  'will',
  'with',
]);

/** Contentful words, lowercased. Stopwords carry no signal about sameness. */
export function tokensOf(statement: string): Set<string> {
  return new Set(
    statement
      .toLowerCase()
      .replace(/[^a-z0-9\s/._-]/g, ' ')
      .split(/\s+/)
      .filter((word) => word.length > 2 && !STOPWORDS.has(word)),
  );
}

export function similarity(a: string, b: string): number {
  const left = tokensOf(a);
  const right = tokensOf(b);
  if (left.size === 0 || right.size === 0) return 0;

  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;

  // Jaccard: shared over the union.
  return shared / (left.size + right.size - shared);
}

/** Same-file overlap, which makes two statements far more likely to be about one thing. */
export function sharesFile(a: LedgerEntry, b: LedgerEntry): boolean {
  const left = new Set(a.filePaths ?? []);
  return (b.filePaths ?? []).some((path) => left.has(path));
}

/**
 * Phrases that flip a statement's polarity. A near-identical statement with one
 * of these on exactly one side is a reversal, not a repeat - the difference
 * between "uses SQLite" and "no longer uses SQLite" is one token and the whole
 * meaning.
 */
const NEGATIONS = [
  'no longer',
  'instead of',
  'reverted',
  'reversed',
  'rolled back',
  'abandoned',
  'replaced',
  'switched away',
  'does not',
  "doesn't",
  'never',
  'without',
];

export function polarityOf(statement: string): boolean {
  const lowered = statement.toLowerCase();
  return NEGATIONS.some((phrase) => lowered.includes(phrase));
}

export const DUPLICATE_THRESHOLD = 0.6;
export const RELATED_THRESHOLD = 0.45;

export interface MergeOptions {
  readonly duplicateThreshold?: number;
  readonly relatedThreshold?: number;
}

/**
 * Decides what to do with a candidate against the entries already on a card.
 *
 * Compared against every existing entry, including superseded ones, so a
 * statement that keeps flip-flopping is recognised each time rather than
 * re-inserted once the previous version is retired.
 */
export function decideMerge(
  candidate: LedgerEntry,
  existing: readonly StoredEntry[],
  options: MergeOptions = {},
): MergeDecision {
  const duplicateAt = options.duplicateThreshold ?? DUPLICATE_THRESHOLD;
  const relatedAt = options.relatedThreshold ?? RELATED_THRESHOLD;

  let best: { entry: StoredEntry; score: number } | null = null;

  for (const entry of existing) {
    if (entry.kind !== candidate.kind) continue;

    const score = similarity(entry.statement, candidate.statement);
    const boosted = sharesFile(entry, candidate) ? Math.min(1, score + 0.15) : score;

    if (best === null || boosted > best.score) best = { entry, score: boosted };
  }

  if (best === null || best.score < relatedAt) {
    return { action: 'inserted', entry: candidate, why: 'Nothing similar on this card.' };
  }

  const reversed = polarityOf(candidate.statement) !== polarityOf(best.entry.statement);

  if (reversed) {
    return {
      action: 'supersedes',
      entry: candidate,
      relatedId: best.entry.id,
      why: `Reverses an earlier ${best.entry.kind}: "${best.entry.statement}"`,
    };
  }

  if (best.score >= duplicateAt) {
    return {
      action: 'duplicate',
      entry: candidate,
      relatedId: best.entry.id,
      why: `Restates an existing ${best.entry.kind}; its sources were folded in.`,
    };
  }

  return { action: 'inserted', entry: candidate, why: 'Related but distinct.' };
}

export interface MergeResult {
  readonly inserted: readonly LedgerEntry[];
  readonly duplicates: readonly MergeDecision[];
  readonly supersessions: readonly MergeDecision[];
  /** Existing entry id to the extra sources folded into it. */
  readonly foldedSources: Readonly<Record<string, readonly number[]>>;
}

export function mergeCandidates(
  candidates: readonly LedgerEntry[],
  existing: readonly StoredEntry[],
  options: MergeOptions = {},
): MergeResult {
  const inserted: LedgerEntry[] = [];
  const duplicates: MergeDecision[] = [];
  const supersessions: MergeDecision[] = [];
  const foldedSources: Record<string, number[]> = {};

  // Candidates are compared against what has already been accepted in this
  // batch as well, or one window emitting the same thing twice inserts twice.
  const pool: StoredEntry[] = [...existing];

  for (const candidate of candidates) {
    const decision = decideMerge(candidate, pool, options);

    if (decision.action === 'duplicate' && decision.relatedId !== undefined) {
      duplicates.push(decision);
      const folded = foldedSources[decision.relatedId] ?? [];
      foldedSources[decision.relatedId] = [...folded, ...candidate.sourceEventIds];
      continue;
    }

    if (decision.action === 'supersedes') supersessions.push(decision);

    inserted.push(candidate);
    pool.push({ ...candidate, id: `pending-${String(pool.length)}` });
  }

  return { inserted, duplicates, supersessions, foldedSources };
}
