import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createCard } from '../src/server/api/cards.js';
import { createDefaultColumns } from '../src/server/cards/defaults.js';
import { reconcileRunningCards } from '../src/server/cards/reconcile.js';
import { openDatabase, type DatabaseHandle } from '../src/server/db/client.js';
import { boards } from '../src/server/db/schema.js';
import {
  acquireLease,
  clearLeases,
  leaseFor,
  ownerId,
  releaseLease,
} from '../src/server/dispatch/lease.js';

/**
 * One dispatcher at a time, per card (T7).
 *
 * The guard this replaces was an in-memory set: per-process, and consulted
 * after the worktree was created. Two servers on one database, or one server
 * racing itself, could both get past it and put two agents in one checkout.
 */

let dir: string;
let handle: DatabaseHandle;
const BOARD = 'board-1';

function card(title: string): string {
  return createCard(handle, { boardId: BOARD, title }).id;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gorilla-lease-'));
  handle = openDatabase({ path: join(dir, 'l.db') });
  handle.db.insert(boards).values({ id: BOARD, name: 'b', cwd: dir, createdAt: 1 }).run();
  createDefaultColumns(handle.db, BOARD);
});

afterEach(() => {
  handle.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('claiming a card', () => {
  it('lets the first claim through', () => {
    expect(acquireLease(handle.sqlite, card('a'), 'owner-1', 1)).toBe(true);
  });

  it('refuses the second, whoever asks', () => {
    const id = card('a');
    acquireLease(handle.sqlite, id, 'owner-1', 1);

    // A different owner is the case that matters: it is a second process, and
    // the in-memory guard could not see it at all.
    expect(acquireLease(handle.sqlite, id, 'owner-2', 2)).toBe(false);
    expect(acquireLease(handle.sqlite, id, 'owner-1', 3)).toBe(false);
  });

  it('does not overwrite who holds it', () => {
    const id = card('a');
    acquireLease(handle.sqlite, id, 'owner-1', 1);
    acquireLease(handle.sqlite, id, 'owner-2', 2);

    // INSERT OR IGNORE, not OR REPLACE. Replacing would hand the card to the
    // loser of the race, which is the exact opposite of the point.
    expect(leaseFor(handle.sqlite, id)?.owner).toBe('owner-1');
  });

  it('lets it be claimed again once released', () => {
    const id = card('a');
    acquireLease(handle.sqlite, id, 'owner-1', 1);
    releaseLease(handle.sqlite, id);

    expect(acquireLease(handle.sqlite, id, 'owner-2', 2)).toBe(true);
  });

  it('claims each card separately', () => {
    acquireLease(handle.sqlite, card('a'), 'owner-1', 1);

    expect(acquireLease(handle.sqlite, card('b'), 'owner-1', 1)).toBe(true);
  });
});

describe('identifying the holder', () => {
  it('is different every time, so a restart is visible', () => {
    // A lease that survived the process holding it is a lease on a run that no
    // longer exists, and startup has to be able to tell.
    expect(ownerId()).not.toBe(ownerId());
  });
});

describe('after a restart', () => {
  it('releases every claim', () => {
    acquireLease(handle.sqlite, card('a'), 'gone', 1);
    acquireLease(handle.sqlite, card('b'), 'gone', 1);

    expect(clearLeases(handle.sqlite)).toBe(2);
  });

  it('is done by the same reconcile that moves the cards', () => {
    const id = card('was running');
    acquireLease(handle.sqlite, id, 'gone', 1);

    const result = reconcileRunningCards(handle.sqlite, Date.now());

    // Otherwise every card in flight during a restart is permanently
    // undispatchable - the same shape of bug as the cards left marked running,
    // and the same fix.
    expect(result.leasesCleared).toBe(1);
    expect(acquireLease(handle.sqlite, id, 'new-owner', 2)).toBe(true);
  });

  it('goes away with the card it belongs to', () => {
    const id = card('deleted');
    acquireLease(handle.sqlite, id, 'owner-1', 1);

    handle.sqlite.prepare('DELETE FROM cards WHERE id = ?').run(id);

    expect(leaseFor(handle.sqlite, id)).toBeNull();
  });

  it('is unbothered by a card that never existed', () => {
    // Foreign keys would refuse this, which is the behaviour wanted: a lease
    // on nothing is a bug somewhere upstream, not a state to tolerate.
    expect(() => acquireLease(handle.sqlite, randomUUID(), 'owner-1', 1)).toThrow();
  });
});
