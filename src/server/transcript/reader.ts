import { createReadStream, existsSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline';

import {
  isKnownRecordType,
  parseLine,
  type AssistantRecord,
  type TranscriptRecord,
  type UserRecord,
} from './records.js';

/**
 * Reading of a transcript file, isolated behind this module (doc 06, P7).
 *
 * Two guarantees, both load-bearing:
 *
 * - Nothing here throws on bad input. A truncated final line is normal while
 *   the file is being appended to; a corrupt file must degrade the utilization
 *   gauge, not take the process down.
 * - Unrecognised record types are counted and surfaced as drift rather than
 *   ignored silently, because the first symptom of a format change should be a
 *   visible diagnostic and not a wrong number (R6).
 */

export interface DriftReport {
  /** Record types seen that are not in the known list, with counts. */
  readonly unknownTypes: Readonly<Record<string, number>>;
  /** Lines that were not valid JSON. */
  readonly unparseableLines: number;
  /** Total lines considered. */
  readonly totalLines: number;
  readonly hasDrift: boolean;
}

export interface TranscriptSummary {
  readonly path: string;
  readonly exists: boolean;
  readonly sizeBytes: number;
  readonly recordCount: number;
  readonly assistantCount: number;
  readonly userCount: number;
  /** Newest assistant model that was not synthetic. */
  readonly model: string | null;
  readonly gitBranch: string | null;
  readonly cwd: string | null;
  /** Most recent real usage block; null when the session has none yet. */
  readonly latestContextTokens: number | null;
  readonly totalOutputTokens: number;
  readonly drift: DriftReport;
}

/**
 * Context windows are not stated in the transcript, and the model id does not
 * reliably distinguish a 1M-context variant from a 200k one. So this is a
 * declared assumption rather than a measurement: callers may override it, and
 * the interface should present the token count as the fact and the percentage
 * as derived.
 */
export const DEFAULT_CONTEXT_WINDOW = 200_000;

class DriftCounter {
  readonly #unknown = new Map<string, number>();
  #unparseable = 0;
  #total = 0;

  line(): void {
    this.#total += 1;
  }

  unparseable(): void {
    this.#unparseable += 1;
  }

  unknownType(type: string): void {
    this.#unknown.set(type, (this.#unknown.get(type) ?? 0) + 1);
  }

  report(): DriftReport {
    return {
      unknownTypes: Object.fromEntries(this.#unknown),
      unparseableLines: this.#unparseable,
      totalLines: this.#total,
      hasDrift: this.#unknown.size > 0 || this.#unparseable > 0,
    };
  }
}

/** Streams a transcript line by line, never loading the whole file. */
export async function readTranscript(
  path: string,
  onRecord?: (record: TranscriptRecord) => void,
): Promise<TranscriptSummary> {
  const drift = new DriftCounter();

  const empty: TranscriptSummary = {
    path,
    exists: false,
    sizeBytes: 0,
    recordCount: 0,
    assistantCount: 0,
    userCount: 0,
    model: null,
    gitBranch: null,
    cwd: null,
    latestContextTokens: null,
    totalOutputTokens: 0,
    drift: drift.report(),
  };

  if (!existsSync(path)) return empty;

  let sizeBytes = 0;
  try {
    sizeBytes = statSync(path).size;
  } catch {
    return empty;
  }

  let recordCount = 0;
  let assistantCount = 0;
  let userCount = 0;
  let model: string | null = null;
  let gitBranch: string | null = null;
  let cwd: string | null = null;
  let latestContextTokens: number | null = null;
  let totalOutputTokens = 0;

  try {
    const stream = createReadStream(path, { encoding: 'utf8' });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });

    for await (const line of lines) {
      drift.line();

      const record = parseLine(line);
      if (record === null) {
        if (line.trim() !== '') drift.unparseable();
        continue;
      }

      recordCount += 1;
      onRecord?.(record);

      if (record.kind === 'assistant') {
        assistantCount += 1;
        if (!record.synthetic && record.model !== null) model = record.model;
        if (record.usage !== null && !record.synthetic) {
          // Take the newest, not the largest: utilization is a current state.
          latestContextTokens = record.usage.contextTokens;
          totalOutputTokens += record.usage.outputTokens;
        }
      } else if (record.kind === 'user') {
        userCount += 1;
        if (record.gitBranch !== null) gitBranch = record.gitBranch;
        if (record.cwd !== null) cwd = record.cwd;
      } else if (!record.known) {
        drift.unknownType(record.type);
      }
    }
  } catch {
    // A read error mid-stream still yields what was read. Partial truth beats
    // an exception on the path that feeds a diagnostic.
    return {
      path,
      exists: true,
      sizeBytes,
      recordCount,
      assistantCount,
      userCount,
      model,
      gitBranch,
      cwd,
      latestContextTokens,
      totalOutputTokens,
      drift: drift.report(),
    };
  }

  return {
    path,
    exists: true,
    sizeBytes,
    recordCount,
    assistantCount,
    userCount,
    model,
    gitBranch,
    cwd,
    latestContextTokens,
    totalOutputTokens,
    drift: drift.report(),
  };
}

export interface Utilization {
  readonly contextTokens: number;
  readonly windowTokens: number;
  readonly fraction: number;
  /** Bands from the ACE-FCA guidance in doc 03: 40-60% is the target range. */
  readonly band: 'low' | 'target' | 'high' | 'critical';
  /**
   * The measured context exceeds the assumed window, which means the
   * assumption is wrong rather than the session impossible - almost always a
   * larger-context model than DEFAULT_CONTEXT_WINDOW. Observed on a real
   * 1M-context session reporting 693,689 tokens against the 200k default.
   *
   * The interface must show the token count and suppress the percentage when
   * this is set: "347% full" is worse than no number at all.
   */
  readonly windowAssumptionInvalid: boolean;
}

export function utilizationFor(
  contextTokens: number | null,
  windowTokens: number = DEFAULT_CONTEXT_WINDOW,
): Utilization | null {
  if (contextTokens === null || windowTokens <= 0) return null;

  const fraction = contextTokens / windowTokens;
  const band =
    fraction < 0.4 ? 'low' : fraction <= 0.6 ? 'target' : fraction <= 0.8 ? 'high' : 'critical';

  return {
    contextTokens,
    windowTokens,
    fraction,
    band,
    windowAssumptionInvalid: fraction > 1,
  };
}

/**
 * The last `maxChars` of assistant and user text, oldest first.
 *
 * This is what `PreCompact` reads: the window about to be discarded (doc 07
 * section 5). Character-bounded rather than token-bounded because we must not
 * pay for a tokenizer on the hook path.
 */
export async function readTailWindow(path: string, maxChars = 200_000): Promise<string> {
  const chunks: string[] = [];
  let total = 0;

  const records: (AssistantRecord | UserRecord)[] = [];
  await readTranscript(path, (record) => {
    if (record.kind === 'assistant' || record.kind === 'user') records.push(record);
  });

  for (let i = records.length - 1; i >= 0 && total < maxChars; i -= 1) {
    const record = records[i];
    if (record === undefined) continue;

    const label = record.kind;
    const body =
      record.kind === 'assistant'
        ? [record.thinking, record.text].filter((s) => s !== '').join('\n')
        : record.text;

    if (body === '') continue;

    const entry = `<${label}>\n${body}\n</${label}>`;
    chunks.push(entry);
    total += entry.length;
  }

  return chunks.reverse().join('\n\n').slice(-maxChars);
}

export { isKnownRecordType };
