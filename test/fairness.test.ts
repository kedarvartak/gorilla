import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createCard } from '../src/server/api/cards.js';
import { createDefaultColumns } from '../src/server/cards/defaults.js';
import { openDatabase, type DatabaseHandle } from '../src/server/db/client.js';
import { boards } from '../src/server/db/schema.js';
import { acquireLease } from '../src/server/dispatch/lease.js';
import {
  DEFAULT_MAX_AGENTS,
  machineLimit,
  mayStart,
  occupancy,
} from '../src/server/dispatch/fairness.js';

/**
 * Sharing one machine between boards (T65).
 *
 * Two boards set to three agents each is six agents on one laptop, competing
 * for the same cores and the same rate limit - and neither board can see the
 * other, so nothing gets slower on purpose.
 */

let dir: string;
let handle: DatabaseHandle;

function board(id: string): void {
  handle.db
    .insert(boards)
    .values({ id, name: id, cwd: `${dir}/${id}`, createdAt: 1 })
    .run();
  createDefaultColumns(handle.db, id);
}

function inFlight(boardId: string, count: number): void {
  for (let index = 0; index < count; index += 1) {
    const card = createCard(handle, { boardId, title: `card ${String(index)}` });
    acquireLease(handle.sqlite, card.id, 'owner', 1);
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gorilla-fairness-'));
  handle = openDatabase({ path: join(dir, 'f.db') });
  board('board-a');
  board('board-b');
});

afterEach(() => {
  handle.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('counting what is in flight', () => {
  it('counts across every board sharing the database', () => {
    inFlight('board-a', 2);
    inFlight('board-b', 1);

    expect(occupancy(handle.sqlite, 'board-a')).toEqual({ total: 3, mine: 2, others: 1 });
  });

  it('counts nothing when nothing is running', () => {
    expect(occupancy(handle.sqlite, 'board-a')).toEqual({ total: 0, mine: 0, others: 0 });
  });
});

describe('deciding whether one more may start', () => {
  it('lets a board on its own use the whole machine', () => {
    // The common case, and the one that must not get slower for a feature
    // about the other case.
    expect(mayStart({ total: 3, mine: 3, others: 0 }, 4).allowed).toBe(true);
  });

  it('stops anyone at the machine limit', () => {
    expect(mayStart({ total: 4, mine: 1, others: 1 }, 4).allowed).toBe(false);
  });

  it('holds a board to its share while another is working', () => {
    // A cap alone means whichever board woke first takes every slot and the
    // other waits - which is not starvation the operator can see, because both
    // boards look like they are working.
    expect(mayStart({ total: 2, mine: 2, others: 1 }, 4).allowed).toBe(false);
    expect(mayStart({ total: 2, mine: 1, others: 1 }, 4).allowed).toBe(true);
  });

  it('rounds a share up, not down', () => {
    // With a cap of 3 and two boards, each gets 2. Rounding down would leave a
    // slot nobody may take, which is a slower machine for the sake of
    // arithmetic.
    expect(mayStart({ total: 1, mine: 1, others: 1 }, 3).allowed).toBe(true);
  });

  it('says which rule stopped it', () => {
    // 'Holding' with no reason is indistinguishable from a stuck queue.
    expect(mayStart({ total: 4, mine: 0, others: 1 }, 4).why).toContain('across every board');
    expect(mayStart({ total: 2, mine: 2, others: 1 }, 4).why).toContain('other board');
  });
});

describe('the limit itself', () => {
  it('defaults to something a laptop survives', () => {
    expect(machineLimit({})).toBe(DEFAULT_MAX_AGENTS);
  });

  it('takes the environment when it is a sensible number', () => {
    expect(machineLimit({ GORILLA_MAX_AGENTS: '8' })).toBe(8);
  });

  it('ignores nonsense rather than stopping the board', () => {
    // A typo in an environment variable should not be able to halt every queue
    // on the machine.
    expect(machineLimit({ GORILLA_MAX_AGENTS: 'lots' })).toBe(DEFAULT_MAX_AGENTS);
    expect(machineLimit({ GORILLA_MAX_AGENTS: '0' })).toBe(DEFAULT_MAX_AGENTS);
    expect(machineLimit({ GORILLA_MAX_AGENTS: '-2' })).toBe(DEFAULT_MAX_AGENTS);
  });
});
