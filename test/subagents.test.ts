import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDatabase, type DatabaseHandle } from '../src/server/db/client.js';
import { boards, events, runs } from '../src/server/db/schema.js';
import {
  describeSubagent,
  durationOf,
  summariseSubagents,
  MAX_RESULT_CHARS,
} from '../src/server/agents/subagents.js';

/**
 * Subagent work, shown as its own (doc 05).
 *
 * The payload shapes here are taken from real deliveries on this board rather
 * than invented: `agent_type` is populated on `SubagentStart` and frequently an
 * empty string on `SubagentStop`, and `SubagentStop` is where the returned
 * message and the subagent's own transcript path arrive.
 */

let dir: string;
let handle: DatabaseHandle;
const BOARD = 'board-1';
const RUN = 'run-1';
let seq = 0;

function event(name: string, payload: Record<string, unknown>, at = 1_000): void {
  seq += 1;
  handle.db
    .insert(events)
    .values({
      runId: RUN,
      sessionId: 'session-1',
      seq,
      eventName: name,
      receivedAt: at,
      payload: JSON.stringify({ session_id: 'session-1', cwd: dir, ...payload }),
    })
    .run();
}

const summaries = () => summariseSubagents(handle.sqlite, RUN);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gorilla-subagents-'));
  handle = openDatabase({ path: join(dir, 'sub.db') });
  seq = 0;

  handle.db.insert(boards).values({ id: BOARD, name: 'b', cwd: dir, createdAt: 1 }).run();
  handle.db
    .insert(runs)
    .values({ id: RUN, boardId: BOARD, sessionId: 'session-1', cwd: dir, startedAt: 1 })
    .run();
});

afterEach(() => {
  handle.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('grouping a subagent’s work', () => {
  beforeEach(() => {
    event('SubagentStart', { agent_id: 'a1', agent_type: 'general-purpose' }, 1_000);
    event(
      'PreToolUse',
      { agent_id: 'a1', tool_name: 'Edit', tool_input: { file_path: 'src/a.ts' } },
      1_500,
    );
    event(
      'PostToolUse',
      { agent_id: 'a1', tool_name: 'Edit', tool_input: { file_path: 'src/a.ts' } },
      1_600,
    );
    event(
      'PreToolUse',
      { agent_id: 'a1', tool_name: 'Edit', tool_input: { file_path: 'src/b.ts' } },
      1_700,
    );
    event(
      'SubagentStop',
      {
        agent_id: 'a1',
        // Real deliveries carry an empty string here, which is why the type is
        // taken from the start event and never overwritten by this one.
        agent_type: '',
        last_assistant_message: 'Renamed the two call sites.',
        agent_transcript_path: '/home/x/.claude/subagents/agent-a1.jsonl',
      },
      4_000,
    );
  });

  it('reports it as one piece of work', () => {
    const [only] = summaries();

    expect(summaries()).toHaveLength(1);
    expect(only?.agentType).toBe('general-purpose');
    expect(only?.finished).toBe(true);
  });

  it('counts tool calls once, not once per half', () => {
    // PreToolUse and PostToolUse are two events for one action; counting both
    // would double every number in this view.
    expect(summaries()[0]?.toolCalls).toBe(2);
  });

  it('names the files it touched', () => {
    // The reason this exists: these edits otherwise arrive in the blast radius
    // attributed to a session that did not make them.
    expect(summaries()[0]?.files).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('keeps what it handed back', () => {
    // The only part of a subagent's reasoning that survives its context being
    // discarded.
    expect(summaries()[0]?.result).toBe('Renamed the two call sites.');
    expect(summaries()[0]?.transcriptPath).toContain('agent-a1.jsonl');
  });

  it('measures how long it ran', () => {
    expect(durationOf(summaries()[0]!)).toBe(3_000);
  });
});

describe('not claiming more than it saw', () => {
  it('gives no duration for a subagent it only saw stop', () => {
    event('PreToolUse', { agent_id: 'a2', tool_name: 'Read' }, 2_000);
    event('SubagentStop', { agent_id: 'a2', last_assistant_message: 'done' }, 2_500);

    // Most subagents on a board configured after the fact have no start event.
    // Inferring one from the first tool call would produce a number that looks
    // measured and is guessed.
    expect(summaries()[0]?.startedAt).toBeNull();
    expect(durationOf(summaries()[0]!)).toBeNull();
  });

  it('shows a subagent that has not stopped as still running', () => {
    event('SubagentStart', { agent_id: 'a3', agent_type: 'Explore' }, 1_000);
    event('PreToolUse', { agent_id: 'a3', tool_name: 'Grep' }, 1_100);

    const [only] = summaries();
    expect(only?.finished).toBe(false);
    expect(describeSubagent(only!)).toContain('is running');
  });

  it('says subagent when no event carried a type', () => {
    event('SubagentStop', { agent_id: 'a4', agent_type: '' }, 1_000);

    expect(summaries()[0]?.agentType).toBeNull();
    expect(describeSubagent(summaries()[0]!)).toContain('subagent');
  });

  it('ignores the parent session’s own events', () => {
    event('PreToolUse', { tool_name: 'Edit', tool_input: { file_path: 'src/main.ts' } }, 1_000);
    event('Stop', {}, 1_100);

    expect(summaries()).toHaveLength(0);
  });

  it('survives an event with nothing useful on it', () => {
    // A malformed body never reaches this table: the events row extracts
    // `agent_id` in a generated column, so SQLite rejects unparsable JSON on
    // insert, and the hook path stores such a body wrapped as
    // `_gorilla_unparsed` instead. What does arrive is a well-formed payload
    // missing the fields we hoped for, which must not throw either (R7).
    event('PreToolUse', { agent_id: 'a6' }, 1_000);
    event('SubagentStop', { agent_id: 'a6' }, 1_100);

    const [only] = summaries();
    expect(only?.files).toEqual([]);
    expect(only?.result).toBeNull();
    expect(only?.toolCalls).toBe(1);
  });
});

describe('keeping the view readable', () => {
  it('truncates an enormous returned message', () => {
    event('SubagentStop', { agent_id: 'a5', last_assistant_message: 'x'.repeat(5_000) }, 1_000);

    const result = summaries()[0]?.result ?? '';
    expect(result.length).toBeLessThanOrEqual(MAX_RESULT_CHARS + 1);
    expect(result.endsWith('…')).toBe(true);
  });

  it('orders subagents by when they started', () => {
    event('SubagentStart', { agent_id: 'late', agent_type: 'a' }, 9_000);
    event('SubagentStart', { agent_id: 'early', agent_type: 'b' }, 2_000);

    expect(summaries().map((entry) => entry.agentId)).toEqual(['early', 'late']);
  });
});
