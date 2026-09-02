import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { narrationFor } from '../src/server/transcript/narration.js';
import { openDatabase, type DatabaseHandle } from '../src/server/db/client.js';
import { boards, cards, columns, runs } from '../src/server/db/schema.js';

/**
 * The agent's own account of a run.
 *
 * The assertions that matter here are about absence. Both providers withhold
 * the reasoning text - Claude Code records a thinking block with no words in
 * it, Codex encrypts its own - and a screen called "model thinking" that shows
 * none of it, silently, would read as a broken feature rather than as an honest
 * one. Saying which is the whole job.
 */

let dir: string;
let database: DatabaseHandle;
const CARD = 'card-1';

function transcript(lines: object[]): string {
  const path = join(
    dir,
    `transcript-${String(lines.length)}-${String(Math.abs(dir.length))}.jsonl`,
  );
  writeFileSync(path, lines.map((line) => JSON.stringify(line)).join('\n'));
  return path;
}

function assistant(content: object[]): object {
  return {
    type: 'assistant',
    timestamp: '2026-08-28T10:00:00.000Z',
    message: { model: 'claude-opus-5', content },
  };
}

function addRun(over: { transcriptPath?: string; id?: string }): string {
  const id = over.id ?? 'run-1';
  database.db
    .insert(runs)
    .values({
      id,
      boardId: 'board-1',
      cardId: CARD,
      sessionId: `session-${id}`,
      cwd: dir,
      startedAt: Date.now(),
      ...(over.transcriptPath === undefined ? {} : { transcriptPath: over.transcriptPath }),
    })
    .run();
  return id;
}

/** A Codex event, in the envelope its recorded sessions use. */
function codexEvent(runId: string, seq: number, payload: object): void {
  database.sqlite
    .prepare(
      'INSERT INTO events (run_id, session_id, seq, event_name, received_at, payload) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run(
      runId,
      `session-${runId}`,
      seq,
      'CodexEvent',
      1_700_000_000_000 + seq,
      JSON.stringify(payload),
    );
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gorilla-narration-'));
  database = openDatabase({ path: join(dir, 'n.db') });
  database.db.insert(boards).values({ id: 'board-1', name: 'b', cwd: dir, createdAt: 1 }).run();
  database.db
    .insert(columns)
    .values({ id: 'col-1', boardId: 'board-1', name: 'Intake', position: 0 })
    .run();
  database.db
    .insert(cards)
    .values({
      id: CARD,
      boardId: 'board-1',
      columnId: 'col-1',
      title: 'A card',
      body: '',
      position: 1,
      status: 'idle',
      createdAt: 1,
      updatedAt: 1,
    })
    .run();
});

afterEach(() => {
  database.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('reading a Claude run', () => {
  it('keeps thinking, speech and tool calls apart', () => {
    addRun({
      transcriptPath: transcript([
        assistant([
          { type: 'thinking', thinking: 'Weighing two approaches.', signature: 'x' },
          { type: 'text', text: 'Reading the stamp first.' },
          { type: 'tool_use', name: 'Bash', input: { command: 'npm test' } },
        ]),
      ]),
    });

    const { entries } = narrationFor(database, CARD);

    expect(entries.map((entry) => entry.kind)).toEqual(['thinking', 'said', 'did']);
    expect(entries[0]?.text).toBe('Weighing two approaches.');
    // Thinking before speech, because it is what produced the sentence after
    // it and the other order reads the conclusion first.
    expect(entries[1]?.text).toBe('Reading the stamp first.');
    expect(entries[2]?.tool).toBe('Bash');
  });

  it('says what a tool was called with, not just its name', () => {
    // "Bash" says an agent ran something. The command says what it did, which
    // is the difference between a log and an account.
    addRun({
      transcriptPath: transcript([
        assistant([{ type: 'tool_use', name: 'Bash', input: { command: 'npm run lint' } }]),
        assistant([{ type: 'tool_use', name: 'Read', input: { file_path: '/repo/a.ts' } }]),
      ]),
    });

    const { entries } = narrationFor(database, CARD);
    expect(entries.map((entry) => entry.text)).toEqual(['npm run lint', '/repo/a.ts']);
  });

  it('counts thinking the harness recorded without its words', () => {
    // What Claude Code actually writes: the block and its signature, no text.
    // Measured on this machine at the time of writing - 1,122 such blocks
    // across eight recent transcripts, none with a single character in them.
    addRun({
      transcriptPath: transcript([
        assistant([
          { type: 'thinking', thinking: '', signature: 'abc' },
          { type: 'text', text: 'Done.' },
        ]),
      ]),
    });

    const narration = narrationFor(database, CARD);

    expect(narration.withheldThinking).toBe(1);
    expect(narration.entries.map((entry) => entry.kind)).toEqual(['said']);
    expect(narration.note).toContain('none of the words were kept');
    // The distinction the note exists to draw.
    expect(narration.note).toContain('withheld by the harness');
  });

  it('leaves tool results out, which is what keeps this readable', () => {
    // A tool result arrives as a user record carrying no text block. Included,
    // this becomes a dump of every byte the tools returned.
    addRun({
      transcriptPath: transcript([
        { type: 'user', message: { content: [{ type: 'tool_result', content: 'x'.repeat(500) }] } },
        { type: 'user', message: { content: [{ type: 'text', text: 'Do the thing.' }] } },
      ]),
    });

    const { entries } = narrationFor(database, CARD);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.kind).toBe('asked');
  });
});

describe('reading a Codex run', () => {
  it('maps what it says and does out of the envelope', () => {
    const run = addRun({});
    codexEvent(run, 1, {
      type: 'event_msg',
      payload: { type: 'agent_message', message: 'Ready.' },
    });
    codexEvent(run, 2, {
      type: 'response_item',
      payload: { type: 'custom_tool_call', name: 'exec', input: 'ls -la' },
    });

    const narration = narrationFor(database, CARD);

    expect(narration.provider).toBe('codex');
    expect(narration.entries.map((entry) => [entry.kind, entry.tool ?? entry.text])).toEqual([
      ['said', 'Ready.'],
      ['did', 'exec'],
    ]);
  });

  it('reads the flatter stream shapes too', () => {
    // The CLI documents `--json` as "Print events to stdout as JSONL" and
    // nothing more, and the envelope has moved between releases. Being wrong
    // about it should cost a line, not the whole screen.
    const run = addRun({});
    codexEvent(run, 1, { type: 'agent_message', message: 'Flat.' });
    codexEvent(run, 2, { msg: { type: 'agent_message', message: 'Wrapped in msg.' } });
    codexEvent(run, 3, { item: { type: 'agent_message', message: 'Wrapped in item.' } });

    const { entries } = narrationFor(database, CARD);
    expect(entries.map((entry) => entry.text)).toEqual([
      'Flat.',
      'Wrapped in msg.',
      'Wrapped in item.',
    ]);
  });

  it('says the reasoning was withheld rather than showing nothing', () => {
    // Codex encrypts it. Measured across 25 local sessions: 1,057 reasoning
    // items, not one with a readable summary.
    const run = addRun({});
    codexEvent(run, 1, {
      type: 'response_item',
      payload: { type: 'reasoning', summary: [], encrypted_content: 'opaque' },
    });
    codexEvent(run, 2, { type: 'event_msg', payload: { type: 'agent_message', message: 'Done.' } });

    const narration = narrationFor(database, CARD);

    expect(narration.withheldThinking).toBe(1);
    expect(narration.note).toContain('none of the words were kept');
  });

  it('ignores the harness talking to the model', () => {
    // A developer message is the harness's own instructions, not either party
    // addressing the operator.
    const run = addRun({});
    codexEvent(run, 1, {
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'developer',
        content: [{ type: 'input_text', text: 'rules' }],
      },
    });
    codexEvent(run, 2, {
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Hello.' }],
      },
    });

    const { entries } = narrationFor(database, CARD);
    expect(entries.map((entry) => entry.text)).toEqual(['Hello.']);
  });
});

describe('what crosses the wire', () => {
  it('returns the tail and says how much it left behind', () => {
    addRun({
      transcriptPath: transcript(
        Array.from({ length: 40 }, (_, index) =>
          assistant([{ type: 'text', text: `line ${String(index)}` }]),
        ),
      ),
    });

    const narration = narrationFor(database, CARD, { limit: 5 });

    expect(narration.total).toBe(40);
    expect(narration.entries).toHaveLength(5);
    // The end of a run is the interesting end.
    expect(narration.entries[4]?.text).toBe('line 39');
  });

  it('answers plainly for a card that has never run', () => {
    const narration = narrationFor(database, CARD);

    expect(narration.entries).toHaveLength(0);
    expect(narration.provider).toBeNull();
    expect(narration.note).toBeNull();
  });

  it('says when the transcript is gone rather than pretending the run was silent', () => {
    addRun({ transcriptPath: join(dir, 'deleted.jsonl') });

    const narration = narrationFor(database, CARD);
    expect(narration.note).toContain('no transcript on disk');
  });
});
