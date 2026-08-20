import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '../src/server/app.js';
import { openDatabase, type DatabaseHandle } from '../src/server/db/client.js';

import { buildBrief, renderBrief, type BriefInput } from '../src/server/brief/brief.js';
import { briefToMarkdown, exportFilename } from '../src/server/brief/markdown.js';

/**
 * The brief as a file somebody else reads (doc 08, export).
 *
 * The assertions are about what a file lacks that a screen supplies. On the
 * board the frame around the brief says which card this is and when it was
 * taken; pasted into a pull request it says neither, and a reader who cannot
 * tell a current summary from a stale one is back where they started.
 */

const base: BriefInput = {
  cardTitle: 'Wire the ingest path',
  cardStatus: 'awaiting-review',
  lastSeenAt: null,
  entries: [],
  entryTimes: {},
  changedFiles: ['src/server/app.ts', 'src/server/ingest/routes.ts'],
  changedButUnmentioned: [],
  verify: null,
  goalVerdict: null,
  compactions: 0,
  runCount: 2,
};

const exported = (over: Partial<BriefInput> = {}): string =>
  briefToMarkdown({
    brief: buildBrief({ ...base, ...over }),
    cardId: 'card-1a2b3c4d5e',
    boardName: 'kanban',
    generatedAt: Date.UTC(2026, 7, 20, 9, 0, 0),
  });

describe('exporting a brief', () => {
  it('keeps the headline and the sections', () => {
    const markdown = exported();

    expect(markdown).toContain('# Wire the ingest path');
    expect(markdown).toContain('## State of the work');
    expect(markdown).toContain('## Blast radius');
  });

  it('gives the file list real list markers', () => {
    const markdown = exported();

    // The on-screen brief indents these two spaces for alignment. Rendered
    // anywhere that understands markdown, that collapses every filename into
    // one run-on paragraph - invisible on the board, fatal in a pull request.
    expect(renderBrief(buildBrief(base))).toContain('  src/server/app.ts');
    expect(markdown).toContain('- src/server/app.ts');
    expect(markdown).toContain('- src/server/ingest/routes.ts');
  });

  it('says when it was taken and what it came from', () => {
    const markdown = exported();

    // A summary with no date is one the reader must either trust blindly or
    // discard, and both are worse than the board it came from.
    expect(markdown).toContain('2026-08-20T09:00:00.000Z');
    expect(markdown).toContain('card-1a2b3c4d5e');
    expect(markdown).toContain('kanban');
    expect(markdown).toContain('Derived from the card ledger');
  });

  it('carries a failed verify into the file', () => {
    const markdown = exported({
      verify: { status: 'failed', command: 'npm test', output: '', durationMs: 1, exitCode: 1 },
    });

    // The one line most worth exporting: the board ran this itself, so it does
    // not depend on the agent having reported honestly.
    expect(markdown).toContain('Verify did NOT pass');
  });

  it('ends with a single trailing newline', () => {
    const markdown = exported();

    expect(markdown.endsWith('\n')).toBe(true);
    expect(markdown.endsWith('\n\n')).toBe(false);
  });
});

describe('naming the file', () => {
  it('uses the title so it can be found again', () => {
    expect(exportFilename('Wire the ingest path', 'card-1a2b3c4d')).toBe(
      'wire-the-ingest-path-card-1a2.md',
    );
  });

  it('survives a title with nothing usable in it', () => {
    // A download called ".md" is one the operator cannot find at all.
    expect(exportFilename('!!!', 'abcdefgh12')).toBe('card-abcdefgh.md');
  });

  it('does not run away with a very long title', () => {
    const name = exportFilename('x'.repeat(200), 'abcdefgh12');

    expect(name.length).toBeLessThan(64);
  });
});

/**
 * The endpoint, over the wire.
 *
 * The header assertions are the feature: a browser that receives markdown as
 * JSON, or without a filename, gives the operator a blob called "brief" and no
 * way to tell one card's export from another's a week later.
 */
describe('GET /api/cards/:cardId/brief.md', () => {
  let dir: string;
  let database: DatabaseHandle;
  let app: FastifyInstance;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'gorilla-export-'));
    database = openDatabase({ path: join(dir, 'export.db') });
    app = buildApp({ database, logger: false });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    database.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function card(): Promise<string> {
    const board = await app.inject({
      method: 'POST',
      url: '/api/boards',
      payload: { name: 'kanban', cwd: dir },
    });
    const created = await app.inject({
      method: 'POST',
      url: `/api/boards/${(board.json() as { id: string }).id}/cards`,
      payload: { title: 'Wire the ingest path' },
    });
    return (created.json() as { id: string }).id;
  }

  it('serves the brief as a markdown file', async () => {
    const cardId = await card();
    const response = await app.inject({ method: 'GET', url: `/api/cards/${cardId}/brief.md` });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/markdown');
    expect(response.body).toContain('# Wire the ingest path');
    expect(response.body).toContain('Derived from the card ledger');
  });

  it('names the download after the card', async () => {
    const cardId = await card();
    const response = await app.inject({ method: 'GET', url: `/api/cards/${cardId}/brief.md` });

    expect(String(response.headers['content-disposition'])).toContain('wire-the-ingest-path');
  });

  it('refuses a card that does not exist rather than exporting an empty file', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/cards/nope/brief.md' });

    // An export is the copy that outlives the board. One invented for a card
    // that never existed is worse than an error.
    expect(response.statusCode).toBeGreaterThanOrEqual(400);
  });
});
