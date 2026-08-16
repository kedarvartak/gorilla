import { createReadStream, existsSync, statSync } from 'node:fs';

import chokidar, { type FSWatcher } from 'chokidar';

import { parseLine, type TranscriptRecord } from './records.js';

/**
 * Follows a transcript file as Claude Code appends to it.
 *
 * Reads only the bytes added since the last read, and holds a trailing partial
 * line in a buffer until its newline arrives - a half-written record is the
 * normal state of a file being appended to, not an error.
 */

export interface TailOptions {
  /** Start from the beginning rather than the current end. */
  readonly fromStart?: boolean;
  readonly onRecord: (record: TranscriptRecord) => void;
  readonly onError?: (error: unknown) => void;
}

export class TranscriptTail {
  #offset = 0;
  #buffer = '';
  #watcher: FSWatcher | null = null;
  #reading = false;
  #pending = false;

  constructor(
    private readonly path: string,
    private readonly options: TailOptions,
  ) {}

  async start(): Promise<void> {
    if (!this.options.fromStart && existsSync(this.path)) {
      try {
        this.#offset = statSync(this.path).size;
      } catch {
        this.#offset = 0;
      }
    }

    this.#watcher = chokidar.watch(this.path, {
      ignoreInitial: true,
      // The file is appended to continuously; waiting for writes to settle
      // would delay every record behind the next one.
      awaitWriteFinish: false,
    });

    this.#watcher.on('change', () => {
      void this.#drain();
    });
    this.#watcher.on('add', () => {
      void this.#drain();
    });
    this.#watcher.on('error', (error) => this.options.onError?.(error));

    // Wait for the watcher to actually be watching. Returning before 'ready'
    // loses every write that lands in the gap, which for a transcript being
    // appended to continuously is not a rare race.
    const watcher = this.#watcher;
    await new Promise<void>((resolve) => {
      const settle = (): void => {
        clearTimeout(timer);
        resolve();
      };
      // Bounded: a watcher that never reports ready must not hang startup.
      const timer = setTimeout(settle, 2_000);
      timer.unref?.();
      watcher.once('ready', settle);
    });

    if (this.options.fromStart) await this.#drain();
  }

  async stop(): Promise<void> {
    await this.#watcher?.close();
    this.#watcher = null;
  }

  /** Reads appended bytes. Coalesces overlapping calls rather than queueing. */
  async #drain(): Promise<void> {
    if (this.#reading) {
      this.#pending = true;
      return;
    }
    this.#reading = true;

    try {
      let size: number;
      try {
        size = statSync(this.path).size;
      } catch {
        return;
      }

      // Truncation or replacement: start over rather than read garbage.
      if (size < this.#offset) {
        this.#offset = 0;
        this.#buffer = '';
      }
      if (size === this.#offset) return;

      const chunk = await this.#read(this.#offset, size - 1);
      this.#offset = size;
      this.#buffer += chunk;

      const lines = this.#buffer.split('\n');
      // The final element is either empty (chunk ended on a newline) or a
      // partial record still being written. Either way it waits.
      this.#buffer = lines.pop() ?? '';

      for (const line of lines) {
        const record = parseLine(line);
        if (record !== null) this.options.onRecord(record);
      }
    } catch (error) {
      this.options.onError?.(error);
    } finally {
      this.#reading = false;
      if (this.#pending) {
        this.#pending = false;
        void this.#drain();
      }
    }
  }

  #read(start: number, end: number): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const chunks: string[] = [];
      const stream = createReadStream(this.path, { encoding: 'utf8', start, end });
      stream.on('data', (chunk: string | Buffer) => chunks.push(chunk.toString()));
      stream.on('end', () => resolve(chunks.join('')));
      stream.on('error', reject);
    });
  }
}
