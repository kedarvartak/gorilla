import { appendFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

import { redactPayload } from './redact.js';

/**
 * Records the hook stream to a JSONL fixture (T5).
 *
 * Everything after Phase 0 is tested against recorded reality rather than
 * invented payloads, so this is not incidental tooling - it is how every later
 * phase gets a realistic input to develop against without needing a live agent.
 *
 * One line per event, preserving arrival order and the delay between events so
 * replay can reproduce the original pacing.
 */

export interface FixtureEntry {
  /** Milliseconds since the first recorded event. */
  readonly t: number;
  readonly event: string;
  readonly payload: unknown;
}

export interface RecorderOptions {
  readonly path: string;
  /** Strip file contents, command output and prompt text. Defaults to true. */
  readonly redact?: boolean;
}

export class FixtureRecorder {
  #firstAt: number | null = null;
  #count = 0;

  constructor(private readonly options: RecorderOptions) {
    mkdirSync(dirname(options.path), { recursive: true });
  }

  get count(): number {
    return this.#count;
  }

  get path(): string {
    return this.options.path;
  }

  /** Appends synchronously: a fixture must not lose the tail on a crash. */
  record(event: string, payload: unknown, now = Date.now()): void {
    this.#firstAt ??= now;

    const entry: FixtureEntry = {
      t: now - this.#firstAt,
      event,
      payload: this.options.redact === false ? payload : redactPayload(payload),
    };

    appendFileSync(this.options.path, `${JSON.stringify(entry)}\n`, 'utf8');
    this.#count += 1;
  }
}

/** Reads a fixture. Skips unparseable lines rather than failing the replay. */
export function readFixture(path: string): FixtureEntry[] {
  if (!existsSync(path)) {
    throw new Error(`Fixture not found: ${path}`);
  }

  const entries: FixtureEntry[] = [];

  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (line.trim() === '') continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }

    if (typeof parsed !== 'object' || parsed === null) continue;

    const candidate = parsed as Partial<FixtureEntry>;
    if (typeof candidate.event !== 'string') continue;

    entries.push({
      t: typeof candidate.t === 'number' ? candidate.t : 0,
      event: candidate.event,
      payload: candidate.payload ?? {},
    });
  }

  return entries;
}
