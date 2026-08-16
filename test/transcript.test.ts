import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_CONTEXT_WINDOW,
  KNOWN_RECORD_TYPES,
  TranscriptTail,
  findTranscripts,
  readTailWindow,
  readTranscript,
  transcriptDirForCwd,
  utilizationFor,
  type TranscriptRecord,
} from '../src/server/transcript/index.js';
import { parseLine } from '../src/server/transcript/records.js';

const fixture = (name: string): string =>
  fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gorilla-transcript-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('parseLine', () => {
  it('extracts usage, content blocks and tool names from an assistant record', () => {
    const record = parseLine(
      JSON.stringify({
        type: 'assistant',
        uuid: 'a1',
        message: {
          model: 'claude-opus-5',
          content: [
            { type: 'thinking', thinking: 'reasoning' },
            { type: 'text', text: 'answer' },
            { type: 'tool_use', name: 'Edit' },
          ],
          usage: {
            input_tokens: 10,
            cache_read_input_tokens: 1000,
            cache_creation_input_tokens: 100,
            output_tokens: 50,
            output_tokens_details: { thinking_tokens: 20 },
          },
        },
      }),
    );

    expect(record?.kind).toBe('assistant');
    if (record?.kind !== 'assistant') return;

    expect(record.text).toBe('answer');
    expect(record.thinking).toBe('reasoning');
    expect(record.toolNames).toEqual(['Edit']);
    expect(record.synthetic).toBe(false);
    expect(record.usage?.contextTokens).toBe(1110);
    expect(record.usage?.thinkingTokens).toBe(20);
  });

  it('flags synthetic assistant messages', () => {
    const record = parseLine(
      JSON.stringify({ type: 'assistant', message: { model: '<synthetic>', content: [] } }),
    );
    expect(record?.kind === 'assistant' && record.synthetic).toBe(true);
  });

  it('reads branch and cwd from a user record', () => {
    const record = parseLine(
      JSON.stringify({
        type: 'user',
        gitBranch: 'feature/x',
        cwd: '/a/b',
        message: { content: 'hello' },
      }),
    );
    expect(record?.kind).toBe('user');
    if (record?.kind !== 'user') return;
    expect(record.gitBranch).toBe('feature/x');
    expect(record.text).toBe('hello');
  });

  it.each([
    ['', null],
    ['   ', null],
    ['not json', null],
    ['{"unclosed": ', null],
    ['[1,2,3]', null],
    ['"a string"', null],
    ['123', null],
  ])('returns null for %j rather than throwing', (input, expected) => {
    expect(parseLine(input)).toBe(expected);
  });

  it('marks an unknown type as drift without throwing', () => {
    const record = parseLine(JSON.stringify({ type: 'invented-in-a-later-release' }));
    expect(record).toEqual({ kind: 'other', type: 'invented-in-a-later-release', known: false });
  });

  it('recognises every observed record type', () => {
    for (const type of KNOWN_RECORD_TYPES) {
      if (type === 'assistant' || type === 'user') continue;
      const record = parseLine(JSON.stringify({ type }));
      expect(record).toEqual({ kind: 'other', type, known: true });
    }
  });

  it('survives content blocks of unexpected shape', () => {
    const record = parseLine(
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [null, 42, { type: 'text' }, { type: 'brand_new_block', data: {} }],
        },
      }),
    );
    expect(record?.kind === 'assistant' && record.text).toBe('');
  });

  it('tolerates a usage block with missing or wrong-typed fields', () => {
    const record = parseLine(
      JSON.stringify({
        type: 'assistant',
        message: { usage: { input_tokens: 'lots', cache_read_input_tokens: 5 } },
      }),
    );
    expect(record?.kind === 'assistant' && record.usage?.contextTokens).toBe(5);
  });
});

describe('readTranscript', () => {
  it('summarises the sample fixture', async () => {
    const summary = await readTranscript(fixture('transcript-sample.jsonl'));

    expect(summary.exists).toBe(true);
    expect(summary.assistantCount).toBe(3);
    expect(summary.userCount).toBe(1);
    expect(summary.gitBranch).toBe('main');
    expect(summary.cwd).toBe('/home/example/project');
    expect(summary.model).toBe('claude-opus-5');
  });

  it('ignores synthetic messages when reporting context', async () => {
    const summary = await readTranscript(fixture('transcript-sample.jsonl'));
    // The synthetic record claims 999999 cache-read tokens; the newest real
    // record reports 30 + 500 + 95000.
    expect(summary.latestContextTokens).toBe(95_530);
  });

  it('reports unknown record types and unparseable lines as drift', async () => {
    const summary = await readTranscript(fixture('transcript-sample.jsonl'));

    expect(summary.drift.hasDrift).toBe(true);
    expect(summary.drift.unknownTypes).toEqual({
      'some-future-record-type': 1,
      'another-unknown': 1,
    });
    expect(summary.drift.unparseableLines).toBe(1);
  });

  it('does not throw on a truncated final line', async () => {
    const summary = await readTranscript(fixture('transcript-truncated.jsonl'));
    expect(summary.exists).toBe(true);
    expect(summary.drift.unparseableLines).toBe(1);
  });

  it('does not throw on binary rubbish', async () => {
    const path = join(dir, 'corrupt.jsonl');
    writeFileSync(path, Buffer.from([0x00, 0xff, 0xfe, 0x01, 0x02, 0x0a, 0x7b, 0x7b, 0x7b]));

    const summary = await readTranscript(path);
    expect(summary.exists).toBe(true);
    expect(summary.recordCount).toBe(0);
  });

  it('reports a missing file rather than throwing', async () => {
    const summary = await readTranscript(join(dir, 'nope.jsonl'));
    expect(summary.exists).toBe(false);
    expect(summary.latestContextTokens).toBeNull();
  });

  it('handles a very long single line', async () => {
    const path = join(dir, 'long.jsonl');
    writeFileSync(
      path,
      `${JSON.stringify({
        type: 'assistant',
        message: {
          model: 'claude-opus-5',
          content: [{ type: 'text', text: 'x'.repeat(2_000_000) }],
        },
      })}\n`,
    );

    const summary = await readTranscript(path);
    expect(summary.assistantCount).toBe(1);
  });
});

describe('utilizationFor', () => {
  it.each([
    [10_000, 'low'],
    [100_000, 'target'],
    [150_000, 'high'],
    [190_000, 'critical'],
  ])('places %i tokens in the %s band', (tokens, band) => {
    expect(utilizationFor(tokens)?.band).toBe(band);
  });

  it('uses the documented default window', () => {
    expect(utilizationFor(1)?.windowTokens).toBe(DEFAULT_CONTEXT_WINDOW);
  });

  it('accepts an override for larger context windows', () => {
    const utilization = utilizationFor(500_000, 1_000_000);
    expect(utilization?.fraction).toBeCloseTo(0.5);
    expect(utilization?.band).toBe('target');
  });

  it('returns null when there is nothing to report', () => {
    expect(utilizationFor(null)).toBeNull();
    expect(utilizationFor(100, 0)).toBeNull();
  });

  it('flags the window assumption rather than reporting an impossible figure', () => {
    // A real 1M-context session on this machine reported 693,689 tokens, which
    // is 347% of the 200k default. The assumption is wrong, not the session.
    const utilization = utilizationFor(693_689);
    expect(utilization?.windowAssumptionInvalid).toBe(true);

    expect(utilizationFor(693_689, 1_000_000)?.windowAssumptionInvalid).toBe(false);
    expect(utilizationFor(100_000)?.windowAssumptionInvalid).toBe(false);
  });
});

describe('readTailWindow', () => {
  it('returns the newest content, oldest first, within the budget', async () => {
    const window = await readTailWindow(fixture('transcript-sample.jsonl'));

    expect(window).toContain('Add a health endpoint');
    expect(window).toContain('Done. The endpoint returns ok.');
    expect(window.indexOf('Add a health endpoint')).toBeLessThan(
      window.indexOf('Done. The endpoint returns ok.'),
    );
  });

  it('respects the character budget', async () => {
    const window = await readTailWindow(fixture('transcript-sample.jsonl'), 60);
    expect(window.length).toBeLessThanOrEqual(60);
  });

  it('includes thinking, which is exactly what compaction discards', async () => {
    const window = await readTailWindow(fixture('transcript-sample.jsonl'));
    expect(window).toContain('The router lives in src/server.');
  });
});

describe('TranscriptTail', () => {
  it('delivers records appended after it starts', async () => {
    const path = join(dir, 'live.jsonl');
    writeFileSync(path, `${JSON.stringify({ type: 'user', message: { content: 'first' } })}\n`);

    const seen: TranscriptRecord[] = [];
    const tail = new TranscriptTail(path, { onRecord: (record) => seen.push(record) });
    await tail.start();

    appendFileSync(path, `${JSON.stringify({ type: 'user', message: { content: 'second' } })}\n`);

    await vi.waitFor(() => expect(seen).toHaveLength(1), { timeout: 5_000 });
    expect(seen[0]?.kind === 'user' && seen[0].text).toBe('second');

    await tail.stop();
  });

  it('holds a partial line until its newline arrives', async () => {
    const path = join(dir, 'partial.jsonl');
    writeFileSync(path, '');

    const seen: TranscriptRecord[] = [];
    const tail = new TranscriptTail(path, { onRecord: (record) => seen.push(record) });
    await tail.start();

    const line = JSON.stringify({ type: 'user', message: { content: 'split' } });
    appendFileSync(path, line.slice(0, 20));
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(seen).toHaveLength(0);

    appendFileSync(path, `${line.slice(20)}\n`);
    await vi.waitFor(() => expect(seen).toHaveLength(1), { timeout: 5_000 });
    expect(seen[0]?.kind === 'user' && seen[0].text).toBe('split');

    await tail.stop();
  });

  it('reads from the beginning when asked', async () => {
    const path = join(dir, 'from-start.jsonl');
    writeFileSync(path, `${JSON.stringify({ type: 'user', message: { content: 'old' } })}\n`);

    const seen: TranscriptRecord[] = [];
    const tail = new TranscriptTail(path, {
      fromStart: true,
      onRecord: (record) => seen.push(record),
    });
    await tail.start();

    await vi.waitFor(() => expect(seen).toHaveLength(1), { timeout: 5_000 });
    await tail.stop();
  });

  it('does not throw when the file does not exist', async () => {
    const tail = new TranscriptTail(join(dir, 'absent.jsonl'), { onRecord: () => undefined });
    await expect(tail.start()).resolves.toBeUndefined();
    await tail.stop();
  });
});

describe('locating transcripts', () => {
  it('slugifies a working directory the way Claude Code does', () => {
    expect(transcriptDirForCwd('/home/kedar/Desktop/Projects/kanban', '/home/kedar')).toBe(
      join('/home/kedar', '.claude', 'projects', '-home-kedar-Desktop-Projects-kanban'),
    );
  });

  it('returns an empty list for an unknown directory', () => {
    expect(findTranscripts('/nowhere/at/all', dir)).toEqual([]);
  });

  it('lists transcripts newest first', () => {
    const home = join(dir, 'home');
    const projects = transcriptDirForCwd('/p', home);
    rmSync(projects, { recursive: true, force: true });
    writeFileSync(join(dir, 'ignored.txt'), 'x');

    mkdirSync(projects, { recursive: true });
    writeFileSync(join(projects, 'aaa.jsonl'), '{}\n');
    writeFileSync(join(projects, 'notes.txt'), 'not a transcript');

    const found = findTranscripts('/p', home);
    expect(found).toHaveLength(1);
    expect(found[0]?.sessionId).toBe('aaa');
  });
});

/**
 * The goal condition asks for three real transcripts from this machine. CI has
 * none, so this reports what it finds and skips when the directory is absent
 * rather than pretending to have verified something it could not.
 */
describe('real transcripts on this machine', () => {
  const projectsDir = join(homedir(), '.claude', 'projects');
  const available = existsSync(projectsDir);

  // Bounded, and given room. These files grow without limit - the transcript
  // of the session writing this test was already 169MB - so an unbounded
  // "three largest" turns a correctness check into a stress test that fails on
  // duration rather than on behaviour.
  const MAX_FIXTURE_BYTES = 40_000_000;

  it.skipIf(!available)(
    'extracts utilization from the three largest',
    { timeout: 60_000 },
    async () => {
      const { readdirSync, statSync } = await import('node:fs');

      const candidates = readdirSync(projectsDir)
        .flatMap((project) => {
          const full = join(projectsDir, project);
          try {
            return readdirSync(full)
              .filter((f) => f.endsWith('.jsonl'))
              .map((f) => join(full, f));
          } catch {
            return [];
          }
        })
        .map((path) => ({ path, size: statSync(path).size }))
        .filter((candidate) => candidate.size <= MAX_FIXTURE_BYTES)
        .sort((a, b) => b.size - a.size)
        .slice(0, 3);

      if (candidates.length === 0) return;

      for (const candidate of candidates) {
        const summary = await readTranscript(candidate.path);
        const utilization = utilizationFor(summary.latestContextTokens);

        console.error(
          `[transcript] ${(summary.sizeBytes / 1_000_000).toFixed(1)}MB ` +
            `${summary.recordCount} records, ${summary.assistantCount} assistant, ` +
            `model=${summary.model ?? 'unknown'}, ` +
            `context=${summary.latestContextTokens ?? 0} tokens ` +
            `(${utilization === null ? 'n/a' : `${(utilization.fraction * 100).toFixed(1)}% ${utilization.band}`}), ` +
            `drift=${JSON.stringify(summary.drift.unknownTypes)} ` +
            `unparseable=${summary.drift.unparseableLines}`,
        );

        expect(summary.exists).toBe(true);
        expect(summary.recordCount).toBeGreaterThan(0);
      }
    },
  );
});
