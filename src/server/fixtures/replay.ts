import { readFixture, type FixtureEntry } from './recorder.js';

/**
 * Replays a recorded fixture into a running board server.
 *
 * Two pacings. `original` reproduces the delays between events, which is what
 * you want when testing behaviour that depends on timing. `fast` sends as
 * quickly as the server accepts them, which is what you want in a test.
 */

export interface ReplayOptions {
  readonly url: string;
  /** Defaults to 'fast'. */
  readonly pacing?: 'fast' | 'original';
  /** Caps any single inter-event wait under 'original' pacing. */
  readonly maxDelayMs?: number;
  readonly onProgress?: (sent: number, total: number) => void;
  readonly signal?: AbortSignal;
}

export interface ReplayResult {
  readonly sent: number;
  readonly failed: number;
  readonly durationMs: number;
  /** Non-2xx responses, by event name. */
  readonly failures: Readonly<Record<string, number>>;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export async function replayEntries(
  entries: readonly FixtureEntry[],
  options: ReplayOptions,
): Promise<ReplayResult> {
  const base = options.url.replace(/\/+$/, '');
  const pacing = options.pacing ?? 'fast';
  const maxDelayMs = options.maxDelayMs ?? 5_000;

  const startedAt = Date.now();
  const failures: Record<string, number> = {};
  let sent = 0;
  let failed = 0;
  let previousT = entries[0]?.t ?? 0;

  for (const entry of entries) {
    if (options.signal?.aborted === true) break;

    if (pacing === 'original') {
      const wait = Math.min(Math.max(entry.t - previousT, 0), maxDelayMs);
      if (wait > 0) await sleep(wait);
      previousT = entry.t;
    }

    try {
      const response = await fetch(`${base}/hooks/${entry.event}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(entry.payload),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });

      if (response.ok) {
        sent += 1;
      } else {
        failed += 1;
        failures[entry.event] = (failures[entry.event] ?? 0) + 1;
      }
      // Body must be consumed or the connection is held open.
      await response.arrayBuffer();
    } catch {
      failed += 1;
      failures[entry.event] = (failures[entry.event] ?? 0) + 1;
    }

    options.onProgress?.(sent + failed, entries.length);
  }

  return { sent, failed, durationMs: Date.now() - startedAt, failures };
}

export async function replayFixture(path: string, options: ReplayOptions): Promise<ReplayResult> {
  return replayEntries(readFixture(path), options);
}
