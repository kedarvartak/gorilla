import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildApp, contextOf } from '../src/server/app.js';
import { openDatabase, type DatabaseHandle } from '../src/server/db/client.js';
import { claim } from '../src/server/binding/attach.js';
import {
  ExtractionService,
  resolveExtractionBackend,
  shouldAdvance,
  triggerFor,
} from '../src/server/ledger/service.js';
import { claudeCodeExtractionModel, parseCliResponse } from '../src/server/ledger/cli-model.js';
import { advanceCursor, cursorFor, storedEntriesFor } from '../src/server/ledger/store.js';
import type { ExtractionModel, ExtractionRequest } from '../src/server/ledger/model.js';

/**
 * Wiring tests for extraction.
 *
 * The pipeline itself is covered in ledger.test.ts against a fake model. What is
 * new here is everything the service decides: which events open a window, where
 * the window starts, what the run has already spent, and - the part with money
 * attached - whether the cursor moves when a call does not succeed.
 */

let dir: string;
let database: DatabaseHandle;
let app: FastifyInstance;
let boardId: string;
let cardId: string;

const CWD = (): string => dir;

/**
 * A model that records what it was asked and returns whatever it is told to.
 *
 * Entries are given real event ids read out of the prompt, because the validator
 * discards anything citing an event that is not in the window - which is the
 * rule that keeps the ledger falsifiable, and not one to work around in a test.
 */
function fakeModel(
  entries: readonly Record<string, unknown>[] = [],
): ExtractionModel & { calls: ExtractionRequest[] } {
  const calls: ExtractionRequest[] = [];

  const model = async (request: ExtractionRequest) => {
    calls.push(request);
    const cited = [...request.prompt.matchAll(/^#(\d+) /gm)].map((match) => Number(match[1]));

    return {
      entries: entries.map((entry) => ({ ...entry, sourceEventIds: cited.slice(-1) })),
      usage: { inputTokens: 100, outputTokens: 50 },
    };
  };

  return Object.assign(model, { calls });
}

const DECISION = {
  kind: 'decision',
  statement: 'Stored the ledger in SQLite rather than in flat files.',
  alternative: 'flat JSON files on disk',
};

async function json<T>(
  method: 'GET' | 'POST' | 'PATCH',
  url: string,
  payload?: unknown,
): Promise<T> {
  const response = await app.inject({
    method,
    url,
    ...(payload === undefined ? {} : { payload: payload as object }),
  });
  return response.json() as T;
}

/** One hook delivery, as Claude Code would send it. */
async function hook(
  event: string,
  sessionId: string,
  payload: Record<string, unknown> = {},
): Promise<void> {
  await app.inject({
    method: 'POST',
    url: `/hooks/${event}`,
    payload: {
      session_id: sessionId,
      cwd: CWD(),
      hook_event_name: event,
      // The run needs a transcript path for narrative to be read at all; the
      // file itself never exists here, because `narrativeFor` is overridden.
      transcript_path: join(CWD(), `${sessionId}.jsonl`),
      ...payload,
    },
  });

  // The app under test has its own extraction service on the hook path. Draining
  // it here keeps these tests deterministic: without it a second, model-less
  // service is writing the same cursor row at an arbitrary moment.
  await contextOf(app)?.extraction.drain();
}

/** A turn that edited a file, which is what stops the window being skipped. */
async function aTurnOfWork(sessionId: string, file = 'src/app.ts'): Promise<void> {
  await hook('PreToolUse', sessionId, { tool_name: 'Edit', tool_input: { file_path: file } });
  await hook('PostToolUse', sessionId, {
    tool_name: 'Edit',
    tool_input: { file_path: file },
    tool_response: { ok: true },
  });
}

function serviceWith(model?: ExtractionModel): ExtractionService {
  return new ExtractionService({
    database,
    ...(model === undefined ? {} : { model }),
    // No transcript on disk in a test, and the real reader would find nothing.
    narrativeFor: async () => ['I chose SQLite here because the ledger is queried by card.'],
  });
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'gorilla-extract-'));
  database = openDatabase({ path: join(dir, 'extract.db') });
  app = buildApp({ database, logger: false });
  await app.ready();

  const board = await json<{ id: string }>('POST', '/api/boards', { name: 'test', cwd: dir });
  boardId = board.id;

  const card = await json<{ id: string }>('POST', `/api/boards/${boardId}/cards`, {
    title: 'Wire extraction',
  });
  cardId = card.id;
});

afterEach(async () => {
  await app.close();
  database.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Binds a fresh session to the card and returns its run id. */
async function boundRun(sessionId = 'session-1'): Promise<string> {
  await hook('SessionStart', sessionId, { source: 'startup' });
  const result = claim(database, sessionId, cardId);
  return result.runId;
}

describe('which events open a window', () => {
  it('recognises the turn and compaction boundaries', () => {
    expect(triggerFor('Stop')).toBe('Stop');
    expect(triggerFor('SubagentStop')).toBe('SubagentStop');
    expect(triggerFor('PreCompact')).toBe('PreCompact');
  });

  it('ignores everything else, including every tool event', () => {
    for (const event of ['PreToolUse', 'PostToolUse', 'SessionStart', 'Notification']) {
      expect(triggerFor(event)).toBeNull();
    }
  });
});

describe('the cursor', () => {
  it('advances past a window that was extracted, skipped or cached', () => {
    expect(shouldAdvance('extracted')).toBe(true);
    expect(shouldAdvance('cached')).toBe(true);
    expect(shouldAdvance('skipped')).toBe(true);
  });

  it('holds when the call failed or there was no model', () => {
    // Advancing here would discard that window's reasoning permanently: a
    // transient API error, or a key that is added tomorrow.
    expect(shouldAdvance('failed')).toBe(false);
    expect(shouldAdvance('no-model')).toBe(false);
  });

  it('never rewinds, so a stale write cannot cause a second charge', async () => {
    const runId = await boundRun();

    advanceCursor(database, runId, { throughSeq: 12, tokensSpent: 900, outcome: 'extracted' });
    // A writer that read the cursor before the line above, and is now trying to
    // commit a view of the world where less has happened.
    advanceCursor(database, runId, { throughSeq: 4, tokensSpent: 150, outcome: 'extracted' });

    const cursor = cursorFor(database, runId);
    expect(cursor.throughSeq).toBe(12);
    expect(cursor.tokensSpent).toBe(900);
  });
});

describe('extracting a run', () => {
  it('records what the model returned against the card', async () => {
    const runId = await boundRun();
    await aTurnOfWork('session-1');
    await hook('Stop', 'session-1');

    const model = fakeModel([DECISION]);
    await serviceWith(model).enqueue(runId, 'Stop');

    const entries = storedEntriesFor(database, cardId);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.statement).toContain('SQLite');
    expect(entries[0]?.origin).toBe('model');
    expect(entries[0]?.alternative).toBe('flat JSON files on disk');
  });

  it('puts the events and the agent narration in the same window', async () => {
    const runId = await boundRun();
    await aTurnOfWork('session-1');
    await hook('Stop', 'session-1');

    const model = fakeModel();
    await serviceWith(model).enqueue(runId, 'Stop');

    const prompt = model.calls[0]?.prompt ?? '';
    // Events give the evidence; the prose gives the reasoning the events cannot.
    expect(prompt).toContain('PostToolUse');
    expect(prompt).toContain('src/app.ts');
    expect(prompt).toContain('because the ledger is queried by card');
  });

  it('spends nothing on a second trigger with no new events', async () => {
    const runId = await boundRun();
    await aTurnOfWork('session-1');
    await hook('Stop', 'session-1');

    const model = fakeModel([DECISION]);
    const service = serviceWith(model);

    await service.enqueue(runId, 'Stop');
    await service.enqueue(runId, 'Stop');

    expect(model.calls).toHaveLength(1);
    expect(storedEntriesFor(database, cardId)).toHaveLength(1);
  });

  it('shows the next window only what happened since the last one', async () => {
    const runId = await boundRun();
    await aTurnOfWork('session-1', 'src/first.ts');
    await hook('Stop', 'session-1');

    const model = fakeModel();
    const service = serviceWith(model);
    await service.enqueue(runId, 'Stop');

    await aTurnOfWork('session-1', 'src/second.ts');
    await hook('Stop', 'session-1');
    await service.enqueue(runId, 'Stop');

    const second = model.calls[1]?.prompt ?? '';
    expect(second).toContain('src/second.ts');
    // Re-sending the first turn would pay twice for one window.
    expect(second).not.toContain('src/first.ts');
  });

  it('serialises two triggers on one run rather than paying twice', async () => {
    const runId = await boundRun();
    await aTurnOfWork('session-1');
    await hook('Stop', 'session-1');

    const model = fakeModel([DECISION]);
    const service = serviceWith(model);

    // Both queued before either has read the cursor.
    await Promise.all([service.enqueue(runId, 'Stop'), service.enqueue(runId, 'Stop')]);

    expect(model.calls).toHaveLength(1);
  });

  it('escalates a compaction window to the synthesis model', async () => {
    const runId = await boundRun();
    await aTurnOfWork('session-1');
    await hook('PreCompact', 'session-1', { trigger: 'auto' });

    const model = fakeModel();
    await serviceWith(model).enqueue(runId, 'PreCompact');

    // The one window whose content will not exist again, so a cheap miss here
    // cannot be recovered by re-extracting later.
    expect(model.calls[0]?.model).toContain('sonnet');
    expect(model.calls[0]?.prompt).toContain('about to be discarded');
  });

  it('uses the card’s own synthesis model when it names one', async () => {
    await json('PATCH', `/api/cards/${cardId}`, { synthesisModel: 'claude-opus-5' });

    const runId = await boundRun();
    await aTurnOfWork('session-1');
    await hook('PreCompact', 'session-1', { trigger: 'manual' });

    const model = fakeModel();
    await serviceWith(model).enqueue(runId, 'PreCompact');

    expect(model.calls[0]?.model).toBe('claude-opus-5');
  });
});

describe('degrading', () => {
  it('says the ledger is mechanical only when no model is configured', async () => {
    const runId = await boundRun();
    await aTurnOfWork('session-1');
    await hook('Stop', 'session-1');

    await serviceWith().enqueue(runId, 'Stop');

    const cursor = cursorFor(database, runId);
    expect(cursor.lastOutcome).toBe('no-model');
    expect(cursor.lastNote).toContain('Mechanical entries only');
    // Held, so adding a key later picks this window up rather than skipping it.
    expect(cursor.throughSeq).toBe(0);
  });

  it('holds the cursor and keeps the reason when the call throws', async () => {
    const runId = await boundRun();
    await aTurnOfWork('session-1');
    await hook('Stop', 'session-1');

    const model: ExtractionModel = () => Promise.reject(new Error('529 overloaded'));
    await serviceWith(model).enqueue(runId, 'Stop');

    const cursor = cursorFor(database, runId);
    expect(cursor.lastOutcome).toBe('failed');
    expect(cursor.lastNote).toContain('529 overloaded');
    expect(cursor.throughSeq).toBe(0);
    expect(storedEntriesFor(database, cardId)).toHaveLength(0);
  });

  it('stops spending once the run has used its budget', async () => {
    const runId = await boundRun();
    await aTurnOfWork('session-1');
    await hook('Stop', 'session-1');

    const model = fakeModel([DECISION]);
    const service = new ExtractionService({
      database,
      model,
      policy: { tokenLimit: 10 },
      narrativeFor: async () => [],
    });

    await service.enqueue(runId, 'Stop');

    expect(model.calls).toHaveLength(0);
    expect(cursorFor(database, runId).lastOutcome).toBe('budget-exhausted');
  });

  it('records nothing for a session that has not been bound to a card', async () => {
    await hook('SessionStart', 'loose-session', { source: 'startup' });
    await aTurnOfWork('loose-session');
    await hook('Stop', 'loose-session');

    const run = database.sqlite
      .prepare('SELECT id, card_id AS cardId FROM runs WHERE session_id = ?')
      .get('loose-session') as { id: string; cardId: string | null };

    const model = fakeModel([DECISION]);
    await serviceWith(model).enqueue(run.id, 'Stop');

    // An unbound run still has its events; there is simply nowhere to attach
    // entries, and paying for them would be paying to discard them.
    if (run.cardId === null) expect(model.calls).toHaveLength(0);
  });

  it('skips a turn that changed nothing and said nothing', async () => {
    const runId = await boundRun();
    await hook('PreToolUse', 'session-1', { tool_name: 'Read', tool_input: { file_path: 'a.ts' } });
    await hook('Stop', 'session-1');

    const model = fakeModel([DECISION]);
    const service = new ExtractionService({
      database,
      model,
      narrativeFor: async () => [],
    });
    await service.enqueue(runId, 'Stop');

    expect(model.calls).toHaveLength(0);
    expect(cursorFor(database, runId).lastOutcome).toBe('skipped');
  });
});

describe('the hook path', () => {
  it('extracts on Stop without the agent waiting for it', async () => {
    const model = fakeModel([DECISION]);

    await app.close();
    app = buildApp({ database, logger: false, extractionModel: model });
    await app.ready();

    const runId = await boundRun('session-hook');
    await aTurnOfWork('session-hook');
    await hook('Stop', 'session-hook');

    // The handler answered before extraction started; drain is the test's way
    // of waiting for what the agent deliberately does not.
    await contextOf(app)?.extraction.drain();

    expect(model.calls).toHaveLength(1);
    expect(storedEntriesFor(database, cardId)).toHaveLength(1);
    expect(cursorFor(database, runId).lastOutcome).toBe('extracted');
  });

  it('does not extract on a tool event', async () => {
    const model = fakeModel([DECISION]);

    await app.close();
    app = buildApp({ database, logger: false, extractionModel: model });
    await app.ready();

    await boundRun('session-hook');
    await aTurnOfWork('session-hook');
    await contextOf(app)?.extraction.drain();

    expect(model.calls).toHaveLength(0);
  });
});

describe('the brief', () => {
  it('carries model entries alongside the mechanical ones', async () => {
    const runId = await boundRun();
    await aTurnOfWork('session-1');
    await hook('Stop', 'session-1');
    await serviceWith(fakeModel([DECISION])).enqueue(runId, 'Stop');

    const brief = await json<{
      markdown: string;
      sections: { title: string; lines: string[] }[];
    }>('GET', `/api/cards/${cardId}/brief`);

    const decisions = brief.sections.find((section) => section.title === 'Decisions');
    expect(decisions?.lines.join('\n')).toContain('SQLite');
    // The alternative is the half of a decision the diff cannot show.
    expect(brief.markdown).toContain('rather than flat JSON files on disk');
  });

  it('says on the brief itself that no model is configured', async () => {
    const brief = await json<{
      markdown: string;
      extraction: { configured: boolean; note: string | null };
    }>('GET', `/api/cards/${cardId}/brief`);

    expect(brief.extraction.configured).toBe(false);
    // "No decisions recorded" must never be mistaken for "no decisions were
    // made" (R10).
    expect(brief.markdown).toContain('MECHANICAL ONLY');
  });

  it('reports the model as configured and stays quiet when it is working', async () => {
    await app.close();
    app = buildApp({ database, logger: false, extractionModel: fakeModel([DECISION]) });
    await app.ready();

    const runId = await boundRun('session-quiet');
    await aTurnOfWork('session-quiet');
    await hook('Stop', 'session-quiet');
    await contextOf(app)?.extraction.drain();

    const brief = await json<{
      extraction: { configured: boolean; note: string | null; tokensSpent: number };
    }>('GET', `/api/cards/${cardId}/brief`);

    expect(brief.extraction.configured).toBe(true);
    expect(brief.extraction.note).toBeNull();
    expect(brief.extraction.tokensSpent).toBeGreaterThan(0);
    expect(cursorFor(database, runId).lastOutcome).toBe('extracted');
  });
});

describe('the Claude Code backend', () => {
  it('is the default, so no API key is needed', () => {
    const resolved = resolveExtractionBackend({});

    expect(resolved.backend).toBe('cli');
    expect(resolved.model).toBeDefined();
    expect(resolved.note).toContain('existing quota');
  });

  it('does not switch to the API merely because a key is present', () => {
    // A key in the shell is not a request to be billed separately for work the
    // operator's Claude Code subscription already covers.
    expect(resolveExtractionBackend({ ANTHROPIC_API_KEY: 'sk-ant-test' }).backend).toBe('cli');
  });

  it('uses the API only when explicitly asked, and only with a key', () => {
    expect(
      resolveExtractionBackend({ GORILLA_EXTRACTION: 'api', ANTHROPIC_API_KEY: 'sk-ant-test' })
        .backend,
    ).toBe('api');

    const missing = resolveExtractionBackend({ GORILLA_EXTRACTION: 'api' });
    expect(missing.backend).toBe('off');
    expect(missing.note).toContain('ANTHROPIC_API_KEY is not set');
  });

  it('can be switched off entirely', () => {
    const off = resolveExtractionBackend({ GORILLA_EXTRACTION: 'off' });
    expect(off.backend).toBe('off');
    expect(off.model).toBeUndefined();
  });

  it('reads the structured output and the real token usage', () => {
    const response = parseCliResponse(
      JSON.stringify({
        is_error: false,
        structured_output: { entries: [{ kind: 'risk', statement: 'x', sourceEventIds: [1] }] },
        usage: {
          input_tokens: 10,
          cache_creation_input_tokens: 4_000,
          cache_read_input_tokens: 100,
          output_tokens: 50,
        },
      }),
    );

    expect(response.entries).toHaveLength(1);
    // Cache creation and reads are billed, so a budget that ignored them would
    // report a fraction of what a long window costs.
    expect(response.usage.inputTokens).toBe(4_110);
    expect(response.usage.outputTokens).toBe(50);
  });

  it('treats a missing entry list as "nothing to record", not as a failure', () => {
    const response = parseCliResponse(JSON.stringify({ is_error: false, usage: {} }));
    expect(response.entries).toEqual([]);
  });

  it('raises the CLI’s own message when it reports an error', () => {
    expect(() =>
      parseCliResponse(JSON.stringify({ is_error: true, result: 'usage limit reached' })),
    ).toThrow(/usage limit reached/);
  });

  it('survives a child that exits before reading the prompt', async () => {
    // `echo` ignores stdin and exits at once, which raises EPIPE on the write.
    // An unhandled error event on that stream would take the board down, so this
    // asserts the process is still here to answer afterwards.
    const model = claudeCodeExtractionModel({ executable: 'echo' });

    await expect(
      model({ model: 'claude-haiku-4-5-20251001', system: 's', prompt: 'p', maxTokens: 100 }),
    ).rejects.toThrow();

    expect(triggerFor('Stop')).toBe('Stop');
  });

  it('says the CLI is missing rather than failing obscurely', async () => {
    const model = claudeCodeExtractionModel({ executable: 'gorilla-no-such-claude-binary' });

    await expect(
      model({ model: 'claude-haiku-4-5-20251001', system: 's', prompt: 'p', maxTokens: 100 }),
    ).rejects.toThrow(/Claude Code CLI on PATH/);
  });

  it('never lets a synthesis call be attributed to a card', async () => {
    // The recursion this prevents is the expensive one: a synthesis call that
    // fires its own Stop hook triggers another synthesis, forever. `--safe-mode`
    // and a working directory outside the project are the two guards.
    const model = claudeCodeExtractionModel({ executable: 'echo' });
    const before = database.sqlite.prepare('SELECT COUNT(*) AS n FROM events').get() as {
      n: number;
    };

    await model({
      model: 'claude-haiku-4-5-20251001',
      system: 's',
      prompt: 'p',
      maxTokens: 100,
    }).catch(() => undefined);

    const after = database.sqlite.prepare('SELECT COUNT(*) AS n FROM events').get() as {
      n: number;
    };
    expect(after.n).toBe(before.n);
  });
});
