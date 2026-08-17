import { stat } from 'node:fs/promises';

import { eq } from 'drizzle-orm';

import type { DatabaseHandle } from '../db/client.js';
import { cards, runs } from '../db/schema.js';
import { readTailWindow } from '../transcript/reader.js';
import {
  extractFromRun,
  memoryCache,
  type ExtractionCache,
  type ExtractionOutcome,
  type TokenBudget,
} from './extract.js';
import { anthropicExtractionModel, type ExtractionModel } from './model.js';
import { advanceCursor, cursorFor, recordEntries, storedEntriesFor } from './store.js';
import type { WindowTrigger } from './window.js';

/**
 * Extraction as a running service (doc 08).
 *
 * The pipeline in extract.ts is a pure function of a window. This is everything
 * around it that the pipeline deliberately does not know: which hook events are
 * worth a window, where the window starts, what the run has already spent, and
 * what to do with the cursor when a call does not succeed.
 *
 * Runs entirely off the hook response path. Nothing here may throw and nothing
 * here may be awaited by the ingest handler, because a slow or broken extraction
 * must not be the reason an unattended run stalls at 3 a.m. (doc 06, fail open).
 */

/** Hook events that close a window worth extracting, and the trigger they map to. */
const TRIGGERS: Readonly<Record<string, WindowTrigger>> = {
  Stop: 'Stop',
  SubagentStop: 'SubagentStop',
  PreCompact: 'PreCompact',
};

export function triggerFor(eventName: string): WindowTrigger | null {
  return TRIGGERS[eventName] ?? null;
}

/**
 * Whether the cursor moves past a window given how extraction ended.
 *
 * The two holds are the interesting entries. A transient API failure that
 * advanced the cursor would discard that window's reasoning permanently, and a
 * board with no API key that advanced would mean adding a key tomorrow starts
 * from tomorrow. In both cases the next trigger re-includes the events, which is
 * cheap: buildWindow is a SQL scan and the truncation ceiling bounds the size.
 */
export function shouldAdvance(outcome: ExtractionOutcome): boolean {
  switch (outcome) {
    case 'failed':
    case 'no-model':
      return false;
    default:
      return true;
  }
}

/**
 * Cost policy.
 *
 * Two figures, both deliberately conservative, and both worth changing once the
 * ledger has been read in anger:
 *
 * - `tokenLimit` is per run, persisted in the cursor, so it survives a restart.
 *   A run that exhausts it degrades to mechanical entries and says so rather
 *   than stopping quietly (doc 08).
 * - `narrativeChars` is how much assistant prose accompanies the events. A
 *   `PreCompact` window gets far more because that prose is about to cease to
 *   exist, which is the one place a cheap miss cannot be recovered.
 */
export interface ExtractionPolicy {
  readonly tokenLimit: number;
  readonly narrativeChars: number;
  readonly compactNarrativeChars: number;
  readonly windowChars: number;
  readonly compactWindowChars: number;
}

export const DEFAULT_POLICY: ExtractionPolicy = {
  tokenLimit: 300_000,
  narrativeChars: 8_000,
  compactNarrativeChars: 60_000,
  windowChars: 24_000,
  compactWindowChars: 80_000,
};

/**
 * Transcripts grow without bound and the narrative read is a full-file pass.
 * Past this size the events alone are the window, and the brief says so.
 */
const MAX_TRANSCRIPT_BYTES = 40 * 1024 * 1024;

export interface ExtractionEvents {
  readonly onExtracted?: (summary: ExtractionSummary) => void;
}

export interface ExtractionSummary {
  readonly runId: string;
  readonly cardId: string | null;
  readonly trigger: WindowTrigger;
  readonly outcome: ExtractionOutcome;
  readonly inserted: number;
  readonly rejected: number;
  readonly tokensSpent: number;
  readonly model: string | null;
  readonly note?: string;
}

export interface ExtractionServiceOptions {
  readonly database: DatabaseHandle;
  /** Absent means mechanical entries only, reported as a `no-model` outcome. */
  readonly model?: ExtractionModel | undefined;
  readonly policy?: Partial<ExtractionPolicy>;
  readonly cache?: ExtractionCache;
  readonly events?: ExtractionEvents;
  /** Overridden in tests, which have no transcript on disk. */
  readonly narrativeFor?: (
    transcriptPath: string,
    trigger: WindowTrigger,
  ) => Promise<readonly string[]>;
}

export class ExtractionService {
  readonly #database: DatabaseHandle;
  readonly #model: ExtractionModel | undefined;
  readonly #policy: ExtractionPolicy;
  readonly #cache: ExtractionCache;
  readonly #events: ExtractionEvents;
  readonly #narrativeFor: (
    transcriptPath: string,
    trigger: WindowTrigger,
  ) => Promise<readonly string[]>;

  /**
   * One chain per run. Two triggers arriving close together would otherwise
   * both read the same cursor, build the same window and pay for it twice.
   */
  readonly #chains = new Map<string, Promise<void>>();

  constructor(options: ExtractionServiceOptions) {
    this.#database = options.database;
    this.#model = options.model;
    this.#policy = { ...DEFAULT_POLICY, ...options.policy };
    this.#cache = options.cache ?? memoryCache();
    this.#events = options.events ?? {};
    this.#narrativeFor = options.narrativeFor ?? defaultNarrative;
  }

  get configured(): boolean {
    return this.#model !== undefined;
  }

  /**
   * Queues extraction for a run. Returns a promise so tests can await it; the
   * ingest path deliberately does not.
   */
  enqueue(runId: string, eventName: string): Promise<void> {
    const trigger = triggerFor(eventName);
    if (trigger === null) return Promise.resolve();

    const prior = this.#chains.get(runId) ?? Promise.resolve();
    const next = prior
      .then(() => this.#extract(runId, trigger))
      .then(
        () => {
          if (this.#chains.get(runId) === next) this.#chains.delete(runId);
        },
        () => {
          if (this.#chains.get(runId) === next) this.#chains.delete(runId);
        },
      );

    this.#chains.set(runId, next);
    return next;
  }

  /** Awaits everything queued. Used on shutdown and by the tests. */
  async drain(): Promise<void> {
    await Promise.allSettled([...this.#chains.values()]);
  }

  async #extract(runId: string, trigger: WindowTrigger): Promise<void> {
    try {
      await this.#extractUnguarded(runId, trigger);
    } catch {
      // Extraction is an enrichment. Losing it costs the operator a summary;
      // throwing here would leave an unhandled rejection in the server.
    }
  }

  async #extractUnguarded(runId: string, trigger: WindowTrigger): Promise<void> {
    const run = this.#database.db.select().from(runs).where(eq(runs.id, runId)).get();
    if (run === undefined) return;

    const cursor = cursorFor(this.#database, runId);
    const throughSeq = run.lastSeq;

    // Nothing new since the last window. Stop after a PreCompact is the common
    // case, and re-extracting would pay twice for one window.
    if (throughSeq <= cursor.throughSeq) return;

    if (run.cardId === null) {
      // Entries are recorded against a card; an unbound run has nowhere to put
      // them. The events are still stored, so claiming the card later and
      // triggering manually recovers this.
      advanceCursor(this.#database, runId, {
        throughSeq: cursor.throughSeq,
        tokensSpent: cursor.tokensSpent,
        outcome: 'skipped',
        note: 'This session is not bound to a card, so there is nothing to record entries against.',
      });
      return;
    }

    const card = this.#database.db.select().from(cards).where(eq(cards.id, run.cardId)).get();

    const compacting = trigger === 'PreCompact';
    const narrative =
      run.transcriptPath === null ? [] : await this.#narrativeFor(run.transcriptPath, trigger);

    const budget: TokenBudget = { limit: this.#policy.tokenLimit, spent: cursor.tokensSpent };
    const existing = storedEntriesFor(this.#database, run.cardId);

    const result = await extractFromRun({
      sqlite: this.#database.sqlite,
      runId,
      trigger,
      afterSeq: cursor.throughSeq,
      throughSeq,
      narrative,
      maxChars: compacting ? this.#policy.compactWindowChars : this.#policy.windowChars,
      ...(this.#model === undefined ? {} : { model: this.#model }),
      ...(card?.synthesisModel === undefined ? {} : { synthesisModel: card.synthesisModel }),
      budget,
      cache: this.#cache,
      existing,
    });

    const recorded =
      result.entries.length === 0
        ? { inserted: 0 }
        : recordEntries(this.#database, run.cardId, runId, result.entries);

    advanceCursor(this.#database, runId, {
      throughSeq: shouldAdvance(result.outcome) ? throughSeq : cursor.throughSeq,
      tokensSpent: budget.spent,
      outcome: result.outcome,
      note: result.note,
    });

    this.#events.onExtracted?.({
      runId,
      cardId: run.cardId,
      trigger,
      outcome: result.outcome,
      inserted: recorded.inserted,
      rejected: result.rejected.length,
      tokensSpent: budget.spent,
      model: result.model,
      ...(result.note === undefined ? {} : { note: result.note }),
    });
  }
}

/**
 * The assistant's own prose for the window, read from the transcript.
 *
 * The reasoning the ledger wants lives here rather than in the events: a tool
 * call records that a file changed, not why the alternative was rejected.
 */
async function defaultNarrative(
  transcriptPath: string,
  trigger: WindowTrigger,
): Promise<readonly string[]> {
  try {
    const info = await stat(transcriptPath);
    if (info.size > MAX_TRANSCRIPT_BYTES) return [];

    const text = await readTailWindow(
      transcriptPath,
      trigger === 'PreCompact'
        ? DEFAULT_POLICY.compactNarrativeChars
        : DEFAULT_POLICY.narrativeChars,
    );
    return text === '' ? [] : [text];
  } catch {
    // A missing or unreadable transcript degrades the window, not the run.
    return [];
  }
}

/**
 * The model from the environment, or an explanation of its absence.
 *
 * Resolved by the CLI rather than by `buildApp`, so that constructing an app in
 * a test can never make a paid API call because the operator's shell happened to
 * export a key.
 */
export function extractionModelFromEnv(env: NodeJS.ProcessEnv = process.env): {
  model?: ExtractionModel;
  note: string;
} {
  const apiKey = env['ANTHROPIC_API_KEY'];

  if (apiKey === undefined || apiKey.trim() === '') {
    return {
      note: 'ANTHROPIC_API_KEY is not set: the ledger will hold mechanical entries only.',
    };
  }

  return {
    model: anthropicExtractionModel({
      apiKey,
      ...(env['ANTHROPIC_BASE_URL'] === undefined ? {} : { baseUrl: env['ANTHROPIC_BASE_URL'] }),
    }),
    note: 'Model extraction is on.',
  };
}
