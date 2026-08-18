import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '../src/server/app.js';
import { PENDING_TTL_MS, PendingBindings } from '../src/server/binding/pending.js';
import { openDatabase, type DatabaseHandle } from '../src/server/db/client.js';
import {
  claimableCards,
  inferCard,
  mergeCard,
  sessionStartContext,
  unattributedRuns,
} from '../src/server/binding/attach.js';
import { claimCommand } from '../src/hooks/plan-command.js';
import { cards, events, runs } from '../src/server/db/schema.js';

let dir: string;
let database: DatabaseHandle;
let app: FastifyInstance;
let boardId: string;

const SESSION = 'aaaa1111-2222-4333-8444-555555555555';

async function hook(event: string, payload: Record<string, unknown>) {
  const response = await app.inject({
    method: 'POST',
    url: `/hooks/${event}`,
    payload: { session_id: SESSION, cwd: dir, hook_event_name: event, ...payload },
  });
  return { status: response.statusCode, body: response.json() as Record<string, unknown> };
}

async function makeCard(title: string): Promise<string> {
  const created = await app.inject({
    method: 'POST',
    url: `/api/boards/${boardId}/cards`,
    payload: { title },
  });
  return (created.json() as { id: string }).id;
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'gorilla-binding-'));
  database = openDatabase({ path: join(dir, 'binding.db') });
  app = buildApp({ database, logger: false });
  await app.ready();

  const board = await app.inject({
    method: 'POST',
    url: '/api/boards',
    payload: { name: 'observed', cwd: dir },
  });
  boardId = (board.json() as { id: string }).id;
});

afterEach(async () => {
  await app.close();
  database.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('SessionStart', () => {
  it('tells an unclaimed session the board is watching and how to bind', async () => {
    const response = await hook('SessionStart', { source: 'startup' });
    const context = (
      response.body['hookSpecificOutput'] as { additionalContext: string } | undefined
    )?.additionalContext;

    expect(context).toContain('observed');
    expect(context).toContain('/gorilla:claim');
  });

  it('offers the open cards to claim', async () => {
    await makeCard('Refactor ingest');

    const response = await hook('SessionStart', { source: 'startup' });
    const context = (
      response.body['hookSpecificOutput'] as { additionalContext: string } | undefined
    )?.additionalContext;

    expect(context).toContain('Refactor ingest');
  });

  it('creates a provisional card so an unclaimed session is never a blind spot', async () => {
    await hook('SessionStart', { source: 'startup' });

    const all = database.db.select().from(cards).all();
    expect(all).toHaveLength(1);
    expect(all[0]?.title).toContain('Unclaimed session');

    // And the run points at it, so its events are attributed.
    expect(unattributedRuns(database, boardId)).toHaveLength(0);
  });

  it('says which card a bound session belongs to', async () => {
    const cardId = await makeCard('Bound work');
    await hook('SessionStart', { source: 'startup' });
    await app.inject({
      method: 'POST',
      url: '/api/claim',
      payload: { sessionId: SESSION, cardId },
    });

    const response = await hook('SessionStart', { source: 'resume' });
    const context = (
      response.body['hookSpecificOutput'] as { additionalContext: string } | undefined
    )?.additionalContext;

    expect(context).toContain('Bound work');
    expect(context).not.toContain('/gorilla:claim');
  });

  it('answers plainly when no board watches the directory', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/hooks/SessionStart',
      payload: { session_id: 'other', cwd: '/somewhere/else', hook_event_name: 'SessionStart' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({});
  });

  it('never fails the hook, whatever the payload', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/hooks/SessionStart',
      payload: { session_id: SESSION, cwd: dir, weird: { nested: [1, 2] } },
    });

    // A session that cannot start because the board misbehaved is the worst
    // possible failure here.
    expect(response.statusCode).toBe(200);
  });
});

describe('claiming', () => {
  it('binds a session to an existing card', async () => {
    const cardId = await makeCard('Real work');
    await hook('SessionStart', { source: 'startup' });

    const response = await app.inject({
      method: 'POST',
      url: '/api/claim',
      payload: { sessionId: SESSION, cardId },
    });

    expect(response.statusCode).toBe(200);
    const run = database.db.select().from(runs).where(eq(runs.sessionId, SESSION)).get();
    expect(run?.cardId).toBe(cardId);
  });

  it('reports an unknown session rather than inventing a run', async () => {
    const cardId = await makeCard('x');
    const response = await app.inject({
      method: 'POST',
      url: '/api/claim',
      payload: { sessionId: 'never-seen', cardId },
    });

    expect(response.statusCode).toBe(404);
  });

  it('names the missing field', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/claim', payload: {} });
    expect(response.statusCode).toBe(400);
    expect((response.json() as { field: string }).field).toBe('sessionId');
  });

  it('lists claimable cards, excluding finished ones', async () => {
    const open = await makeCard('open');
    const done = await makeCard('done');
    database.db.update(cards).set({ status: 'done' }).where(eq(cards.id, done)).run();

    const titles = claimableCards(database, boardId).map((card) => card.title);
    expect(titles).toContain('open');
    expect(titles).not.toContain('done');
    expect(open).toBeDefined();
  });
});

describe('inferred cards', () => {
  it('titles from a hint when one is available', async () => {
    await hook('Stop', {});
    const run = database.db.select().from(runs).where(eq(runs.sessionId, SESSION)).get();

    const card = inferCard(database, run?.id ?? '', 'Investigate the flaky ingest test');
    expect(card.title).toBe('Investigate the flaky ingest test');
  });

  it('falls back to the session id, which is honest if unhelpful', async () => {
    await hook('Stop', {});
    const run = database.db.select().from(runs).where(eq(runs.sessionId, SESSION)).get();

    expect(inferCard(database, run?.id ?? '', null).title).toContain('Unclaimed session');
  });

  it('is idempotent for a run that already has a card', async () => {
    await hook('SessionStart', { source: 'startup' });
    const run = database.db.select().from(runs).where(eq(runs.sessionId, SESSION)).get();

    const first = inferCard(database, run?.id ?? '', null);
    const second = inferCard(database, run?.id ?? '', null);

    expect(second.id).toBe(first.id);
    expect(database.db.select().from(cards).all()).toHaveLength(1);
  });
});

describe('merging', () => {
  it('moves runs and their events onto the target card', async () => {
    await hook('SessionStart', { source: 'startup' });
    await hook('PostToolUse', { tool_name: 'Edit' });
    await hook('Stop', {});

    const provisional = database.db.select().from(cards).all()[0];
    const target = await makeCard('The real card');

    const result = mergeCard(database, provisional?.id ?? '', target);

    expect(result.movedRuns).toBe(1);
    expect(result.movedEvents).toBeGreaterThan(0);

    // The work happened, so it has to remain attributable.
    const run = database.db.select().from(runs).where(eq(runs.sessionId, SESSION)).get();
    expect(run?.cardId).toBe(target);
    expect(database.db.select().from(events).all().length).toBe(result.movedEvents);
  });

  it('removes the provisional card once folded in', async () => {
    await hook('SessionStart', { source: 'startup' });

    const provisional = database.db.select().from(cards).all()[0];
    const target = await makeCard('target');

    mergeCard(database, provisional?.id ?? '', target);

    expect(
      database.db
        .select()
        .from(cards)
        .all()
        .map((card) => card.id),
    ).toEqual([target]);
  });

  it('refuses to merge a card into itself', async () => {
    const id = await makeCard('lonely');
    expect(() => mergeCard(database, id, id)).toThrow(/itself/);
  });

  it('is reachable over the API', async () => {
    await hook('SessionStart', { source: 'startup' });
    const provisional = database.db.select().from(cards).all()[0];
    const target = await makeCard('target');

    const response = await app.inject({
      method: 'POST',
      url: `/api/cards/${provisional?.id}/merge`,
      payload: { into: target },
    });

    expect(response.statusCode).toBe(200);
  });
});

describe('sessionStartContext', () => {
  it('reads as instruction, not decoration', () => {
    const context = sessionStartContext(database, boardId, 'my-board', null);

    expect(context).toContain('my-board');
    expect(context).toContain('provisional card');
    expect(context).toContain('/gorilla:claim');
  });

  it('copes with a board that has no cards yet', () => {
    expect(sessionStartContext(database, boardId, 'empty', null)).toContain('no open cards');
  });
});

describe('the /gorilla:claim command', () => {
  const command = claimCommand('http://127.0.0.1:4300');

  it('points at the claim endpoint', () => {
    expect(command).toContain('/api/claim');
  });

  it('tells the agent claiming changes attribution only', () => {
    expect(command).toContain('does not start or change any work');
  });
});

describe('a launched binding at concurrency above one', () => {
  it('keys the expectation on the session’s own directory, not the board’s', () => {
    const pending = new PendingBindings();

    // Since U2 the child runs in the card's worktree, so that is the cwd the
    // session reports. An expectation filed under the board's checkout is
    // looked up under a path nothing ever sends.
    pending.expect('/repo/.gorilla/worktrees/card-a', 'card-a');

    expect(pending.claim('/repo')).toBeNull();
    expect(pending.claim('/repo/.gorilla/worktrees/card-a')).toBe('card-a');
  });

  it('is unambiguous for two cards, whichever session starts first', () => {
    const pending = new PendingBindings();

    pending.expect('/repo/.gorilla/worktrees/card-a', 'card-a');
    pending.expect('/repo/.gorilla/worktrees/card-b', 'card-b');

    // Reverse order to the launches: the second card's session wins the race.
    // One worktree per card means order cannot matter.
    expect(pending.claim('/repo/.gorilla/worktrees/card-b')).toBe('card-b');
    expect(pending.claim('/repo/.gorilla/worktrees/card-a')).toBe('card-a');
  });

  it('refuses to answer when two launches share one directory', () => {
    // Only possible with isolation off. Guessing would attach a night's work to
    // the wrong card and say nothing; an unbound session becomes a provisional
    // card, which is visible and correctable.
    const pending = new PendingBindings();
    pending.expect('/repo', 'card-a');
    pending.expect('/repo', 'card-b');

    expect(pending.liveCount('/repo')).toBe(2);
    expect(pending.claim('/repo')).toBeNull();
  });

  it('answers again once the ambiguity clears', () => {
    const pending = new PendingBindings();
    pending.expect('/repo', 'card-a');
    pending.expect('/repo', 'card-b');
    pending.release('/repo', 'card-b');

    expect(pending.claim('/repo')).toBe('card-a');
  });

  it('does not let an expired expectation make a directory look ambiguous', () => {
    const pending = new PendingBindings();
    pending.expect('/repo', 'stale', 1_000);
    pending.expect('/repo', 'card-a', 1_000 + PENDING_TTL_MS);

    // The stale launch never produced a session. It must not block the
    // directory for ever, nor capture an unrelated session later.
    expect(pending.claim('/repo', 1_000 + PENDING_TTL_MS + 1)).toBe('card-a');
  });

  it('releases by directory and card together', () => {
    const pending = new PendingBindings();
    pending.expect('/w/a', 'card-a');
    pending.expect('/w/b', 'card-b');

    pending.release('/w/a', 'card-a');

    expect(pending.claim('/w/a')).toBeNull();
    expect(pending.claim('/w/b')).toBe('card-b');
  });
});
