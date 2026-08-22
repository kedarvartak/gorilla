import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { startServer, type RunningServer } from '../src/server/start.js';
import { createCard } from '../src/server/api/cards.js';
import { createDefaultColumns } from '../src/server/cards/defaults.js';
import { openDatabase } from '../src/server/db/client.js';
import { boards, ledgerEntries, runs } from '../src/server/db/schema.js';
import { WORKTREE_DIR } from '../src/server/worktree/manager.js';
import {
  buildPrompt,
  MAX_DIFF_CHARS,
  parseFindings,
  SYSTEM,
  type Finding,
} from '../src/server/review/second-opinion.js';
import { randomUUID } from 'node:crypto';

/**
 * A fresh reading of the branch, before the gate opens (T36).
 *
 * Everything the board knows about a run comes from that run: the ledger is
 * synthesised from its own events, the verify is a command the card chose, and
 * the diff is what the agent decided to write.
 */

describe('reading what the reviewer said', () => {
  it('takes risks and questions', () => {
    const findings = parseFindings({
      findings: [
        { kind: 'risk', statement: 'The retry has no bound.' },
        { kind: 'question', statement: 'Is this path reachable?' },
      ],
    });

    expect(findings.map((finding) => finding.kind)).toEqual(['risk', 'question']);
  });

  it('drops a kind the ledger should not get from a reviewer', () => {
    // A decision would record a choice it did not make; a change would restate
    // the diff it was handed. Both already come from the run itself.
    expect(parseFindings({ findings: [{ kind: 'decision', statement: 'Chose X.' }] })).toEqual([]);
  });

  it('drops a finding with nothing to say', () => {
    expect(parseFindings({ findings: [{ kind: 'risk', statement: '   ' }] })).toEqual([]);
  });

  it('answers empty rather than throwing on a shape it did not expect', () => {
    expect(parseFindings({ nope: true })).toEqual([]);
    expect(parseFindings(null)).toEqual([]);
  });
});

describe('what the reviewer is asked', () => {
  it('is told not to restate the diff', () => {
    // Whoever reads this has the diff. A summary of it is a cost with no
    // reader.
    expect(SYSTEM).toContain('Do not restate what the diff does');
  });

  it('is told an empty answer is expected', () => {
    // Without this a reviewer invents a finding to look useful, and the gate
    // holds a merge over something nobody needed to read.
    expect(SYSTEM).toContain('expected often');
  });

  it('says when the diff was cut, rather than cutting it quietly', () => {
    const prompt = buildPrompt({
      cardTitle: 'a card',
      goal: null,
      diff: 'x'.repeat(MAX_DIFF_CHARS + 100),
    });

    // Reviewing a third of a change while reporting on all of it is worse than
    // declining: the operator reads "nothing worrying" about unread code.
    expect(prompt).toContain('has been cut to');
  });

  it('says nothing about cutting when it did not', () => {
    expect(buildPrompt({ cardTitle: 'a card', goal: null, diff: 'small' })).not.toContain('cut to');
  });
});

describe('through the board', () => {
  const PORT = 4491;

  let dir: string;
  let repo: string;
  let server: RunningServer;
  let boardId: string;
  let cardId: string;
  let findings: Finding[];

  function git(...args: string[]): string {
    return execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
  }

  async function start(withBranch: boolean): Promise<void> {
    const dbPath = join(dir, 's.db');
    const handle = openDatabase({ path: dbPath });

    boardId = 'board-1';
    handle.db.insert(boards).values({ id: boardId, name: 'b', cwd: repo, createdAt: 1 }).run();
    createDefaultColumns(handle.db, boardId);
    cardId = createCard(handle, { boardId, title: 'a card' }).id;

    handle.db
      .insert(runs)
      .values({
        id: randomUUID(),
        boardId,
        cardId,
        sessionId: randomUUID(),
        startedAt: Date.now(),
        cwd: repo,
      })
      .run();
    handle.close();

    if (withBranch) {
      // A real worktree, laid out where the manager looks, so `adopt` finds it
      // when the server starts. Driving the dispatcher would launch an agent.
      git('worktree', 'add', '-q', '-b', 'gorilla/work', join(repo, WORKTREE_DIR, cardId));
      writeFileSync(join(repo, WORKTREE_DIR, cardId, 'app.txt'), 'one\ntwo\n');
      execFileSync('git', ['commit', '-qam', 'the work'], {
        cwd: join(repo, WORKTREE_DIR, cardId),
      });
    }

    server = await startServer({
      port: PORT,
      dbPath,
      cwd: repo,
      ensureBoard: false,
      logger: false,
      reviewer: vi.fn().mockImplementation(() => Promise.resolve(findings)),
    });
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gorilla-second-opinion-'));
    repo = join(dir, 'repo');
    execFileSync('git', ['init', '-q', repo]);
    execFileSync('git', ['config', 'user.email', 't@example.com'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'T'], { cwd: repo });
    writeFileSync(join(repo, 'app.txt'), 'one\n');
    git('add', '.');
    git('commit', '-qm', 'initial');

    findings = [{ kind: 'risk', statement: 'The retry has no bound.', filePath: 'app.txt' }];
  });

  afterEach(async () => {
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  async function review() {
    return server.app.inject({ method: 'POST', url: `/api/cards/${cardId}/second-opinion` });
  }

  it('refuses a card with no branch', async () => {
    await start(false);
    const response = await review();

    expect(response.statusCode).toBe(409);
    expect(response.json<{ error: string }>().error).toContain('no branch');
  });

  it('records each finding as something nobody has judged', async () => {
    await start(true);
    const response = await review();

    expect(response.statusCode).toBe(200);

    const entries = server.database.db.select().from(ledgerEntries).all();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.statement).toBe('The retry has no bound.');
    // A reviewer that could settle its own findings would be a second agent
    // deciding what is safe, which is what the gate exists to prevent.
    expect(entries[0]?.operatorStatus).toBe('unreviewed');
    expect(entries[0]?.origin).toBe('model');
  });

  it('says it read the diff and found nothing, rather than saying nothing', async () => {
    findings = [];
    await start(true);

    // An empty list from a reviewer that read the diff and an empty list from
    // one that fell over look identical otherwise.
    expect(review().then((r) => r.json<{ note: string }>().note)).resolves.toContain(
      'raised nothing',
    );
  });

  it('refuses a branch that changes nothing', async () => {
    await start(false);
    git('worktree', 'add', '-q', '-b', 'gorilla/empty', join(repo, WORKTREE_DIR, cardId));
    await server.stop();
    server = await startServer({
      port: PORT,
      dbPath: join(dir, 's.db'),
      cwd: repo,
      ensureBoard: false,
      logger: false,
      reviewer: vi.fn().mockImplementation(() => Promise.resolve(findings)),
    });

    const response = await review();

    // Reporting "no findings" on an empty branch is a pass nobody earned.
    expect(response.statusCode).toBe(409);
    expect(response.json<{ error: string }>().error).toContain('changes nothing');
  });
});
