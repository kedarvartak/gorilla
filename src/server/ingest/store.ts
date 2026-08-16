import type Database from 'better-sqlite3';

import { BindingResolver } from './binding.js';

/**
 * The write half of the hook path.
 *
 * One transaction per event: bump the run's sequence counter and insert the
 * row. Doing both under a single transaction is what makes `seq` monotonic per
 * run without an application-level lock, which matters because subagent and
 * async hooks can deliver out of order (doc 06).
 */

export interface IngestInput {
  readonly eventName: string;
  readonly sessionId: string;
  readonly cwd: string;
  readonly transcriptPath: string | null;
  readonly payload: unknown;
  readonly receivedAt: number;
}

export interface IngestOutput {
  readonly runId: string;
  readonly boardId: string;
  readonly seq: number;
  readonly runCreated: boolean;
}

export class EventStore {
  readonly #binding: BindingResolver;
  readonly #bumpSeq: Database.Statement<[string], { last_seq: number }>;
  readonly #insertEvent: Database.Statement<[string, string, number, string, number, string]>;
  readonly #write: (input: IngestInput) => IngestOutput;

  constructor(private readonly sqlite: Database.Database) {
    this.#binding = new BindingResolver(sqlite);

    this.#bumpSeq = sqlite.prepare(
      'UPDATE runs SET last_seq = last_seq + 1 WHERE id = ? RETURNING last_seq',
    );
    this.#insertEvent = sqlite.prepare(
      'INSERT INTO events (run_id, session_id, seq, event_name, received_at, payload) VALUES (?, ?, ?, ?, ?, ?)',
    );

    this.#write = sqlite.transaction((input: IngestInput): IngestOutput => {
      const run = this.#binding.resolve(input.sessionId, input.cwd, input.transcriptPath);
      const bumped = this.#bumpSeq.get(run.runId);

      if (bumped === undefined) {
        throw new Error(`Run vanished while writing an event: ${run.runId}`);
      }

      this.#insertEvent.run(
        run.runId,
        input.sessionId,
        bumped.last_seq,
        input.eventName,
        input.receivedAt,
        JSON.stringify(input.payload),
      );

      return {
        runId: run.runId,
        boardId: run.boardId,
        seq: bumped.last_seq,
        runCreated: run.created,
      };
    });
  }

  write(input: IngestInput): IngestOutput {
    return this.#write(input);
  }
}
