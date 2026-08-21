import type { Database } from 'better-sqlite3';

import type { Dispatcher } from './dispatch/dispatcher.js';

/**
 * What the board is doing, in one request (T44).
 *
 * `/health` returned a hardcoded `ok`, which for an unattended board is worse
 * than returning nothing: a monitor built on it reports a healthy board while
 * the queue is halted, every card is blocked, and no event has arrived in six
 * hours. An endpoint that cannot fail is not a health check, it is a liveness
 * check wearing the wrong name.
 *
 * So this reports facts rather than a verdict. `status` is derived from them
 * and is deliberately coarse, because the interesting question - is this board
 * getting anywhere - is not one an HTTP handler can answer, and a confident
 * green from something that cannot tell is how monitoring lies.
 */

export type HealthStatus = 'ok' | 'attention';

export interface BoardHealth {
  readonly boardId: string;
  readonly name: string;
  /** Cards eligible to be dispatched right now. */
  readonly queued: number;
  readonly running: number;
  readonly blocked: number;
  readonly halted: {
    readonly reason: string;
    readonly cardTitle: string;
    readonly at: number;
  } | null;
}

export interface Health {
  readonly status: HealthStatus;
  readonly uptimeMs: number;
  readonly boards: readonly BoardHealth[];
  /**
   * When the last hook event arrived, across every board.
   *
   * Null when none ever has, which is a different fact from "none recently"
   * and the one that usually means the hooks are pointing somewhere else.
   */
  readonly lastEventAt: number | null;
}

interface Counts {
  readonly queued: number;
  readonly blocked: number;
}

function countsFor(sqlite: Database, boardId: string): Counts {
  const row = sqlite
    .prepare(
      `SELECT
         SUM(CASE WHEN status = 'idle' THEN 1 ELSE 0 END) AS queued,
         SUM(CASE WHEN status = 'blocked' THEN 1 ELSE 0 END) AS blocked
       FROM cards WHERE board_id = ?`,
    )
    .get(boardId) as { queued: number | null; blocked: number | null };

  return { queued: row.queued ?? 0, blocked: row.blocked ?? 0 };
}

export function readHealth(input: {
  readonly sqlite: Database;
  readonly dispatcher: Dispatcher;
  readonly startedAt: number;
  readonly now: number;
}): Health {
  const boards = input.sqlite.prepare('SELECT id, name FROM boards').all() as {
    id: string;
    name: string;
  }[];

  const reported = boards.map((board) => {
    const state = input.dispatcher.state(board.id);
    const counts = countsFor(input.sqlite, board.id);

    return {
      boardId: board.id,
      name: board.name,
      queued: counts.queued,
      blocked: counts.blocked,
      running: state.running.length,
      halted:
        state.halted === null
          ? null
          : {
              reason: state.halted.reason,
              cardTitle: state.halted.cardTitle,
              at: state.halted.at,
            },
    };
  });

  const last = input.sqlite.prepare('SELECT MAX(received_at) AS at FROM events').get() as {
    at: number | null;
  };

  // Attention, not "unhealthy". A halted queue is often the gate working
  // correctly - it stopped for something that needs a person - and calling
  // that a failure teaches the operator to ignore the signal.
  const status: HealthStatus = reported.some((board) => board.halted !== null) ? 'attention' : 'ok';

  return {
    status,
    uptimeMs: input.now - input.startedAt,
    boards: reported,
    lastEventAt: last.at,
  };
}
