import type { Database } from 'better-sqlite3';

/**
 * Sharing one machine between boards (T65).
 *
 * Concurrency is a board setting. Two boards set to three agents each is six
 * agents on one laptop, competing for the same cores, the same test runner and
 * the same rate limit - and neither board can see the other, so neither can be
 * blamed and nothing gets slower on purpose.
 *
 * The lease table already knows what is in flight everywhere, because T7 put
 * it there to stop a card being dispatched twice. It answers this question too.
 */

export const MAX_AGENTS_ENV = 'GORILLA_MAX_AGENTS';

/**
 * Four, when nobody says otherwise.
 *
 * High enough that a single board at its default concurrency of one never
 * notices, low enough that two boards left on automatic cannot fill a laptop.
 * From the environment rather than the database, like the other limits that
 * have to survive a restart to be worth anything.
 */
export const DEFAULT_MAX_AGENTS = 4;

export function machineLimit(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env[MAX_AGENTS_ENV]);
  return Number.isInteger(raw) && raw > 0 ? raw : DEFAULT_MAX_AGENTS;
}

export interface Occupancy {
  /** Cards in flight across every board sharing this database. */
  readonly total: number;
  /** How many of them belong to the board asking. */
  readonly mine: number;
  /** Boards other than this one that currently hold a slot. */
  readonly others: number;
}

export function occupancy(sqlite: Database, boardId: string): Occupancy {
  const rows = sqlite
    .prepare(
      `SELECT cards.board_id AS boardId, COUNT(*) AS n
       FROM card_leases
       JOIN cards ON cards.id = card_leases.card_id
       GROUP BY cards.board_id`,
    )
    .all() as { boardId: string; n: number }[];

  const total = rows.reduce((sum, row) => sum + row.n, 0);
  const mine = rows.find((row) => row.boardId === boardId)?.n ?? 0;

  return { total, mine, others: rows.filter((row) => row.boardId !== boardId).length };
}

export interface Verdict {
  readonly allowed: boolean;
  readonly why: string;
}

/**
 * Whether this board may start one more.
 *
 * Two rules, and the second is the one that makes it fair rather than merely
 * bounded. A cap alone means whichever board woke first takes every slot and
 * the other waits for it to finish - which is not starvation the operator can
 * see, because both boards look like they are working.
 *
 * So while another board holds a slot, no board may hold more than its share
 * of the cap. A board on its own is unaffected, which is the common case and
 * the one that must not get slower for a feature about the other case.
 */
export function mayStart(occupancy: Occupancy, limit: number): Verdict {
  if (occupancy.total >= limit) {
    return {
      allowed: false,
      why: `${String(occupancy.total)} of ${String(limit)} agent slots are in use across every board on this machine.`,
    };
  }

  if (occupancy.others === 0) return { allowed: true, why: '' };

  // Ceiling, not floor: with a cap of 4 and two boards, each gets 2. With a
  // cap of 3, each gets 2 rather than 1 - rounding down would leave a slot
  // nobody may take, which is a slower machine for the sake of arithmetic.
  const share = Math.ceil(limit / (occupancy.others + 1));
  if (occupancy.mine >= share) {
    return {
      allowed: false,
      why: `This board holds ${String(occupancy.mine)} of its ${String(share)} slots while ${String(occupancy.others)} other board(s) are working.`,
    };
  }

  return { allowed: true, why: '' };
}
