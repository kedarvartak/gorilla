import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '../src/server/app.js';
import { openDatabase, type DatabaseHandle } from '../src/server/db/client.js';
import { boards, runs } from '../src/server/db/schema.js';

/**
 * The conversation, not the events (T71).
 *
 * The board has stored a transcript path on every run since Phase 0 and has
 * never opened one. The timeline shows what the hooks saw - a tool asked for,
 * a tool answered - which is the shape of the work and not its reasoning.
 */

let dir: string;
let database: DatabaseHandle;
let app: FastifyInstance;
let runId: string;

function run(transcriptPath: string | null): string {
  const id = randomUUID();
  database.db
    .insert(runs)
    .values({
      id,
      boardId: 'b',
      sessionId: randomUUID(),
      startedAt: 1,
      cwd: dir,
      ...(transcriptPath === null ? {} : { transcriptPath }),
    })
    .run();
  return id;
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'gorilla-transcript-'));
  database = openDatabase({ path: join(dir, 't.db') });
  database.db.insert(boards).values({ id: 'b', name: 'b', cwd: dir, createdAt: 1 }).run();

  app = buildApp({ database, logger: false });
  await app.ready();
});

afterEach(async () => {
  await app.close();
  database.close();
  rmSync(dir, { recursive: true, force: true });
});

async function transcript(id: string) {
  const response = await app.inject({ method: 'GET', url: `/api/runs/${id}/transcript` });
  return { status: response.statusCode, body: response.json<Record<string, unknown>>() };
}

describe('reading a run back', () => {
  it('returns the conversation', async () => {
    const path = join(dir, 'session.jsonl');
    writeFileSync(
      path,
      [
        JSON.stringify({ type: 'user', message: { role: 'user', content: 'do the thing' } }),
        JSON.stringify({
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'text', text: 'done the thing' }] },
        }),
      ].join('\n'),
    );
    runId = run(path);

    const { body } = await transcript(runId);

    expect(body['available']).toBe(true);
    expect(String(body['text'])).toContain('done the thing');
  });

  it('says a run recorded no path, rather than failing', async () => {
    runId = run(null);

    // An attached session that never reported one, or a run from before the
    // path was recorded, simply has nothing to open.
    const { body } = await transcript(runId);

    expect(body['available']).toBe(false);
    expect(String(body['note'])).toContain('no transcript path');
  });

  it('says the file is gone, rather than returning an empty transcript', async () => {
    runId = run(join(dir, 'never-existed.jsonl'));
    expect(existsSync(join(dir, 'never-existed.jsonl'))).toBe(false);

    // The file is Claude Code's, not the board's, and it can be cleaned up
    // underneath. An empty transcript would read as a run that said nothing.
    const { body } = await transcript(runId);

    expect(body['available']).toBe(false);
    expect(String(body['note'])).toContain('no longer at');
  });

  it('answers 404 for a run that does not exist', async () => {
    expect((await transcript('no-such-run')).status).toBe(404);
  });
});
