import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildApp, contextOf } from '../src/server/app.js';
import { openDatabase, type DatabaseHandle } from '../src/server/db/client.js';
import { ledgerEntries, runs } from '../src/server/db/schema.js';
import { GATE_REACH, mergeGate, acknowledgedPaths } from '../src/server/review/gate.js';
import type { Surprise } from '../src/server/ledger/surprises.js';

/**
 * The merge gate (P3).
 *
 * The interesting assertion is not the 409 - it is that the branch is still
 * unmerged afterwards. A refusal that has already merged something is not a
 * gate, and only git can say which happened.
 */

let dir: string;
let repo: string;
let database: DatabaseHandle;
let app: FastifyInstance;
let boardId: string;
let boardCwd: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

async function json<T>(
  method: 'GET' | 'POST',
  url: string,
  payload?: unknown,
): Promise<{ status: number; body: T }> {
  const response = await app.inject({
    method,
    url,
    ...(payload === undefined ? {} : { payload: payload as object }),
  });

  return {
    status: response.statusCode,
    body: response.body === '' ? (undefined as T) : (response.json() as T),
  };
}

/** A card with a real worktree, a committed change on its branch, and a run. */
async function cardWithWork(
  title: string,
  file: string,
): Promise<{ cardId: string; branch: string; runId: string }> {
  const created = await json<{ id: string }>('POST', `/api/boards/${boardId}/cards`, { title });
  const cardId = created.body.id;

  const manager = contextOf(app)?.dispatcher.worktreesFor(boardCwd);
  const workspace = await manager?.create(cardId, title);
  if (workspace === undefined || !workspace.ok) throw new Error('no worktree');

  writeFileSync(join(workspace.path, file), 'work\n');
  git(workspace.path, 'add', '.');
  git(workspace.path, 'commit', '-qm', `work for ${title}`);

  const runId = randomUUID();
  database.db
    .insert(runs)
    .values({
      id: runId,
      boardId,
      cardId,
      sessionId: randomUUID(),
      startedAt: Date.now(),
      cwd: workspace.path,
      // Null so the reality check compares nothing: this test is about the
      // ledger surprise, and a commit range would add unmentioned paths too.
      headShaAtStart: null,
    })
    .run();

  return { cardId, branch: workspace.branch, runId };
}

function addAssumption(cardId: string, runId: string, statement: string): string {
  const id = randomUUID();
  database.db
    .insert(ledgerEntries)
    .values({
      id,
      cardId,
      runId,
      kind: 'assumption',
      statement,
      filePaths: '[]',
      sourceEventIds: '[]',
      origin: 'model',
      createdAt: Date.now(),
    })
    .run();
  return id;
}

function mergedIntoMain(): string[] {
  return (
    git(repo, 'branch', '--merged', 'main')
      .split('\n')
      // '+' marks a branch checked out in another worktree, '*' the current one.
      .map((line) => line.replace(/^[*+]/, '').trim())
      .filter((line) => line !== '')
  );
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'gorilla-gate-'));
  repo = join(dir, 'repo');

  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  git(repo, 'config', 'user.email', 't@example.com');
  git(repo, 'config', 'user.name', 'T');
  writeFileSync(join(repo, 'app.txt'), 'original\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'initial');

  database = openDatabase({ path: join(dir, 'gate.db') });
  app = buildApp({ database, logger: false });
  await app.ready();

  const board = await json<{ id: string; cwd: string }>('POST', '/api/boards', {
    name: 'gate',
    cwd: repo,
  });
  boardId = board.body.id;
  boardCwd = board.body.cwd;
});

afterEach(async () => {
  await app.close();
  database.close();
  rmSync(dir, { recursive: true, force: true });
});

interface Refusal {
  readonly error: string;
  readonly reach: string;
  readonly blocked: readonly { cardId: string; surprises: readonly { headline: string }[] }[];
  readonly outstanding: number;
}

describe('the merge gate', () => {
  it('refuses, merges nothing, and merges once the surprise is judged', async () => {
    const { cardId, branch, runId } = await cardWithWork('gated card', 'gated.txt');
    const entryId = addAssumption(cardId, runId, 'The token refresh happens before the retry.');

    const refused = await json<Refusal>('POST', `/api/boards/${boardId}/review/merge`, {
      cardIds: [cardId],
      into: 'main',
    });

    expect(refused.status).toBe(409);
    expect(refused.body.outstanding).toBe(1);
    expect(refused.body.blocked[0]?.cardId).toBe(cardId);
    // Named, not counted: a count would send the operator hunting for it.
    expect(refused.body.blocked[0]?.surprises[0]?.headline).toContain(
      'The token refresh happens before the retry.',
    );
    // R10 aimed at ourselves: the board says what it cannot stop.
    expect(refused.body.reach).toBe(GATE_REACH);
    expect(refused.body.reach).toMatch(/terminal/);

    // The assertion that matters: git, not the response, says nothing merged.
    expect(mergedIntoMain()).not.toContain(branch);
    expect(existsSync(join(repo, 'gated.txt'))).toBe(false);

    const judged = await json('POST', `/api/ledger/${entryId}/status`, { status: 'accepted' });
    expect(judged.status).toBe(200);

    const merged = await json<{ clean: boolean; merged: number }>(
      'POST',
      `/api/boards/${boardId}/review/merge`,
      { cardIds: [cardId], into: 'main' },
    );

    expect(merged.status).toBe(200);
    expect(merged.body.merged).toBe(1);
    expect(merged.body.clean).toBe(true);
    expect(mergedIntoMain()).toContain(branch);
    expect(existsSync(join(repo, 'gated.txt'))).toBe(true);
  });

  it('holds the clean cards back too rather than half-applying a batch', async () => {
    const clean = await cardWithWork('clean card', 'clean.txt');
    const gated = await cardWithWork('gated card', 'gated.txt');
    addAssumption(gated.cardId, gated.runId, 'Nobody checked this.');

    const refused = await json<Refusal>('POST', `/api/boards/${boardId}/review/merge`, {
      cardIds: [clean.cardId, gated.cardId],
      into: 'main',
    });

    expect(refused.status).toBe(409);
    expect(refused.body.blocked).toHaveLength(1);
    expect(refused.body.error).toContain('half-applied');
    expect(mergedIntoMain()).not.toContain(clean.branch);
    expect(mergedIntoMain()).not.toContain(gated.branch);
  });

  it('retires a changed-but-unmentioned path, which has no row to judge', async () => {
    const { cardId } = await cardWithWork('path card', 'path.txt');

    const acked = await json<{ path: string }>('POST', `/api/cards/${cardId}/surprises/path`, {
      path: 'src/quiet.ts',
    });

    expect(acked.status).toBe(201);

    const brief = await json<{ surprises: Surprise[] }>('GET', `/api/cards/${cardId}/brief`);
    expect(brief.body.surprises.some((surprise) => surprise.id === 'path:src/quiet.ts')).toBe(
      false,
    );

    const noRun = await json('POST', `/api/cards/${cardId}/surprises/path`, { path: '' });
    expect(noRun.status).toBe(400);
  });
});

describe('the gate as a decision', () => {
  const surprise = (id: string): Surprise => ({
    id,
    kind: 'assumption',
    cardId: 'c',
    headline: `Assumed, never verified: ${id}`,
    why: 'Nothing in the tool output confirmed this.',
    filePaths: [],
    sourceEventIds: [],
    target: { type: 'entry', entryId: id },
  });

  it('lets a batch with nothing outstanding through', () => {
    expect(mergeGate([{ cardId: 'c', title: 't', branch: 'b', surprises: [] }])).toBeNull();
  });

  it('counts every outstanding surprise, not every blocked card', () => {
    const refusal = mergeGate([
      { cardId: 'c', title: 't', branch: 'b', surprises: [surprise('one'), surprise('two')] },
    ]);

    expect(refusal?.outstanding).toBe(2);
    expect(refusal?.mergedNothing).toBe(true);
  });

  it('counts a path as acknowledged only through its own acknowledgement', () => {
    const entries = [
      {
        statement: 'Looked at, unmentioned by the run: src/a.ts',
        filePaths: ['src/a.ts'],
        operatorStatus: 'accepted',
      },
      {
        statement: 'Looked at, unmentioned by the run: src/b.ts',
        filePaths: ['src/b.ts'],
        operatorStatus: 'unreviewed',
      },
      { statement: 'Rewrote the retry loop.', filePaths: ['src/c.ts'], operatorStatus: 'accepted' },
    ];

    expect([...acknowledgedPaths(entries)]).toEqual(['src/a.ts']);
  });
});
