import { mkdtempSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '../src/server/app.js';
import { openDatabase, type DatabaseHandle } from '../src/server/db/client.js';
import { claim } from '../src/server/binding/attach.js';
import { ledgerEntries } from '../src/server/db/schema.js';

import {
  buildRepairBlock,
  DEFAULT_REPAIR_CHARS,
  eligibleForRepair,
  repairIsEmpty,
} from '../src/server/context/repair.js';
import { EMPTY_GUARDRAILS, parseGuardrails } from '../src/server/cards/guardrails.js';
import type { StoredEntry } from '../src/server/ledger/dedupe.js';

/**
 * Compaction repair (doc 12, output 3).
 *
 * `PreCompact` extraction has worked since W1; nothing was ever handed back. The
 * rules that matter here are about what may be re-injected, because an agent
 * acts on whatever it is given: a stale claim is worse than silence.
 */

function entry(over: Partial<StoredEntry> = {}): StoredEntry {
  return {
    id: 'e1',
    kind: 'decision',
    statement: 'Stored the ledger in SQLite',
    alternative: 'flat files',
    sourceEventIds: [1],
    origin: 'model',
    supersededBy: null,
    operatorStatus: 'unreviewed',
    ...over,
  };
}

const RAILS = parseGuardrails(
  JSON.stringify({ prohibit: ['src/db/schema.ts'], verify: 'npm test', scope: ['src/server/'] }),
);

describe('what may be re-injected', () => {
  it('takes anything from the run being repaired, reviewed or not', () => {
    // The freshest material there is: extracted from the very window that was
    // just discarded, minutes ago.
    expect(
      eligibleForRepair(entry({ operatorStatus: 'unreviewed' }), {
        runId: 'run-1',
        entryRunId: 'run-1',
      }),
    ).toBe(true);
  });

  it('refuses unreviewed content from an earlier run', () => {
    // Exactly the speculative material doc 12 excludes: nobody has checked it,
    // and the agent will act on it as though someone had.
    expect(
      eligibleForRepair(entry({ operatorStatus: 'unreviewed' }), {
        runId: 'run-2',
        entryRunId: 'run-1',
      }),
    ).toBe(false);
  });

  it('takes an earlier entry the operator accepted', () => {
    expect(
      eligibleForRepair(entry({ operatorStatus: 'accepted' }), {
        runId: 'run-2',
        entryRunId: 'run-1',
      }),
    ).toBe(true);
  });

  it('never takes a rejected entry, even from this run', () => {
    // The operator has said it is wrong. Handing it back would be the board
    // arguing with its own operator.
    expect(
      eligibleForRepair(entry({ operatorStatus: 'rejected' }), {
        runId: 'run-1',
        entryRunId: 'run-1',
      }),
    ).toBe(false);
  });
});

describe('the block', () => {
  it('leads with the rules and says which are enforced', () => {
    const block = buildRepairBlock({ cardTitle: 'A card', guardrails: RAILS, entries: [entry()] });

    expect(block.text).toContain('Rules for this card');
    // An agent told a rule is enforced when it is only advice will not treat it
    // as its own problem to keep.
    expect(block.text).toMatch(/\(hard\)/);
    expect(block.text).toMatch(/\(advisory\)/);
  });

  it('says the material came from the board, not from memory', () => {
    const block = buildRepairBlock({ cardTitle: 'A card', guardrails: RAILS, entries: [entry()] });

    // The agent has just been handed a summary of its own past by compaction.
    // This has to read as more reliable than that, or it is worth nothing.
    expect(block.text).toContain('recovered from the board');
    expect(block.text).toContain('recorded at the time');
  });

  it('carries a decision with the alternative it rejected', () => {
    const block = buildRepairBlock({ cardTitle: 'A card', guardrails: RAILS, entries: [entry()] });
    expect(block.text).toContain('Stored the ledger in SQLite (rather than flat files)');
  });

  it('drops a superseded entry', () => {
    const block = buildRepairBlock({
      cardTitle: 'A card',
      guardrails: EMPTY_GUARDRAILS,
      entries: [entry({ supersededBy: 'e2' })],
    });

    // Re-injecting something already reversed is the stale-claim failure in its
    // purest form: the board knows better and would say it anyway.
    expect(repairIsEmpty(block)).toBe(true);
  });

  it('is empty when there is nothing certain to say', () => {
    const block = buildRepairBlock({
      cardTitle: 'A card',
      guardrails: EMPTY_GUARDRAILS,
      entries: [],
    });
    expect(repairIsEmpty(block)).toBe(true);
  });
});

describe('the budget', () => {
  const many = (kind: StoredEntry['kind'], count: number): StoredEntry[] =>
    Array.from({ length: count }, (_, index) =>
      entry({
        id: `${kind}-${String(index)}`,
        kind,
        statement: `${kind} number ${String(index)} with enough words to take up real room`,
        ...(kind === 'decision' ? {} : { alternative: undefined }),
      }),
    );

  it('trims open questions before decisions', () => {
    const block = buildRepairBlock({
      cardTitle: 'A card',
      guardrails: RAILS,
      entries: [...many('decision', 12), ...many('question', 12)],
      maxChars: 900,
    });

    // A question the agent cannot answer alone costs least to lose: it will
    // simply be asked again. A forgotten decision gets re-litigated wrongly.
    expect(block.trimmed).toBe(true);
    expect(block.text).toContain('Decided earlier');
    expect(block.text).not.toContain('Still open');
  });

  it('never trims the rules', () => {
    const block = buildRepairBlock({
      cardTitle: 'A card',
      guardrails: RAILS,
      entries: many('decision', 40),
      maxChars: 400,
    });

    expect(block.text).toContain('src/db/schema.ts');
  });

  it('reports a card whose rules alone will not fit', () => {
    const block = buildRepairBlock({
      cardTitle: 'A card',
      guardrails: RAILS,
      entries: [],
      maxChars: 60,
    });

    // Doc 12 asks for this by name: guardrails are never trimmed, so rules that
    // do not fit mean the card is over-specified, and that is worth saying.
    expect(block.overSpecified).toBe(true);
  });

  it('stays small enough not to defeat the compaction it follows', () => {
    const block = buildRepairBlock({
      cardTitle: 'A card',
      guardrails: RAILS,
      entries: [...many('decision', 50), ...many('assumption', 50), ...many('question', 50)],
    });

    expect(block.text.length).toBeLessThanOrEqual(DEFAULT_REPAIR_CHARS);
  });
});

describe('through the hook, which is the path that had never run', () => {
  let dir: string;
  let database: DatabaseHandle;
  let app: FastifyInstance;
  let cardId: string;

  async function hook(event: string, payload: Record<string, unknown> = {}): Promise<string> {
    const response = await app.inject({
      method: 'POST',
      url: `/hooks/${event}`,
      payload: { session_id: 'session-1', cwd: dir, hook_event_name: event, ...payload },
    });
    return response.body;
  }

  function recordEntry(over: Partial<typeof ledgerEntries.$inferInsert> = {}): void {
    const run = database.sqlite
      .prepare('SELECT id FROM runs WHERE session_id = ?')
      .get('session-1') as { id: string };

    database.db
      .insert(ledgerEntries)
      .values({
        id: randomUUID(),
        cardId,
        runId: run.id,
        kind: 'decision',
        statement: 'Chose a worktree per card rather than one shared checkout',
        alternative: 'one shared checkout',
        sourceEventIds: '[1]',
        origin: 'model',
        createdAt: Date.now(),
        ...over,
      })
      .run();
  }

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'gorilla-repair-'));
    database = openDatabase({ path: join(dir, 'repair.db') });
    app = buildApp({ database, logger: false });
    await app.ready();

    await app.inject({ method: 'POST', url: '/api/boards', payload: { name: 't', cwd: dir } });
    const boards = await app.inject({ method: 'GET', url: '/api/boards' });
    const boardId = (boards.json() as { id: string }[])[0]?.id ?? '';

    const card = await app.inject({
      method: 'POST',
      url: `/api/boards/${boardId}/cards`,
      payload: {
        title: 'Worktree isolation',
        guardrails: { prohibit: ['src/db/schema.ts'], verify: 'npm test' },
      },
    });
    cardId = (card.json() as { id: string }).id;

    await hook('SessionStart', { source: 'startup' });
    claim(database, 'session-1', cardId);
  });

  afterEach(async () => {
    await app.close();
    database.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('hands back what the compaction took', async () => {
    recordEntry();

    const body = await hook('SessionStart', { source: 'compact' });

    // The whole loop, end to end: PreCompact extraction recorded this, and the
    // SessionStart that follows compaction gives it back.
    expect(body).toContain('Your context was just compacted');
    expect(body).toContain('worktree per card');
    expect(body).toContain('src/db/schema.ts');
  });

  it('says nothing extra on an ordinary session start', async () => {
    recordEntry();

    const body = await hook('SessionStart', { source: 'startup' });

    // Priming a fresh session with a repair block would be telling it about a
    // compaction that never happened.
    expect(body).not.toContain('was just compacted');
    expect(body).toContain('Gorilla board');
  });

  it('hands back the rules even when no entries were extracted', async () => {
    // Guardrails are the one thing in the block nobody synthesised: the operator
    // wrote them, so they are certain, and they are exactly what an agent must
    // not forget mid-run. Worth injecting on their own.
    const body = await hook('SessionStart', { source: 'compact' });

    expect(body).toContain('was just compacted');
    expect(body).toContain('src/db/schema.ts');
  });

  it('falls back to the greeting when the card has nothing at all', async () => {
    const boards = await app.inject({ method: 'GET', url: '/api/boards' });
    const boardId = (boards.json() as { id: string }[])[0]?.id ?? '';

    const bare = await app.inject({
      method: 'POST',
      url: `/api/boards/${boardId}/cards`,
      payload: { title: 'No rules, no history' },
    });
    claim(database, 'session-1', (bare.json() as { id: string }).id);

    // Nothing certain to say. A session start that injects nothing beats one
    // that invents something.
    const body = await hook('SessionStart', { source: 'compact' });
    expect(body).not.toContain('was just compacted');
    expect(body).toContain('Gorilla board');
  });

  it('does not hand back something the operator rejected', async () => {
    recordEntry({ operatorStatus: 'rejected', statement: 'The exporter is unused' });

    const body = await hook('SessionStart', { source: 'compact' });
    expect(body).not.toContain('The exporter is unused');
  });
});
