import { describe, expect, it } from 'vitest';

import { buildBrief, renderBrief, type BriefInput } from '../src/server/brief/brief.js';
import {
  decideMerge,
  mergeCandidates,
  polarityOf,
  similarity,
  type StoredEntry,
} from '../src/server/ledger/dedupe.js';
import type { LedgerEntry } from '../src/server/ledger/entries.js';

const stored = (
  id: string,
  kind: LedgerEntry['kind'],
  statement: string,
  extra: Partial<StoredEntry> = {},
): StoredEntry => ({
  id,
  kind,
  statement,
  sourceEventIds: [1],
  origin: 'model',
  ...extra,
});

const candidate = (
  kind: LedgerEntry['kind'],
  statement: string,
  extra: Partial<LedgerEntry> = {},
): LedgerEntry => ({
  kind,
  statement,
  sourceEventIds: [2],
  origin: 'model',
  ...extra,
});

function input(overrides: Partial<BriefInput> = {}): BriefInput {
  return {
    cardTitle: 'Add the ingest endpoint',
    cardStatus: 'awaiting-review',
    lastSeenAt: 1_000,
    entries: [],
    entryTimes: {},
    changedFiles: [],
    changedButUnmentioned: [],
    verify: null,
    goalVerdict: null,
    compactions: 0,
    runCount: 1,
    ...overrides,
  };
}

describe('similarity', () => {
  it('scores a restatement highly and unrelated text low', () => {
    expect(
      similarity('the ingest path writes one row', 'ingest writes a single row'),
    ).toBeGreaterThan(0.2);
    expect(similarity('the ingest path writes one row', 'the button is blue')).toBe(0);
  });

  it('ignores stopwords, which carry no signal', () => {
    expect(similarity('the and of', 'a but for')).toBe(0);
  });
});

describe('polarity', () => {
  it.each(['no longer uses SQLite', 'reverted the schema change', 'does not retry'])(
    'detects a reversal in %j',
    (statement) => {
      expect(polarityOf(statement)).toBe(true);
    },
  );

  it('reads a plain statement as unreversed', () => {
    expect(polarityOf('uses SQLite for storage')).toBe(false);
  });
});

describe('deduplication', () => {
  it('folds a restatement into the entry it duplicates', () => {
    const existing = [stored('e1', 'decision', 'storage uses SQLite with WAL enabled')];
    const decision = decideMerge(
      candidate('decision', 'storage uses SQLite, WAL enabled'),
      existing,
    );

    expect(decision.action).toBe('duplicate');
    expect(decision.relatedId).toBe('e1');
  });

  it('inserts something genuinely new', () => {
    const existing = [stored('e1', 'decision', 'storage uses SQLite with WAL enabled')];
    expect(
      decideMerge(candidate('decision', 'the API returns 409 on a cycle'), existing).action,
    ).toBe('inserted');
  });

  it('treats a reversal as supersession rather than a duplicate', () => {
    const existing = [stored('e1', 'decision', 'storage uses SQLite with WAL enabled')];
    const decision = decideMerge(
      candidate('decision', 'storage no longer uses SQLite with WAL enabled'),
      existing,
    );

    // Deleting the earlier entry would destroy the most informative thing in a
    // long run: that this was decided, then reversed.
    expect(decision.action).toBe('supersedes');
    expect(decision.why).toContain('Reverses');
  });

  it('does not merge across kinds', () => {
    const existing = [stored('e1', 'risk', 'storage uses SQLite with WAL enabled')];
    expect(
      decideMerge(candidate('decision', 'storage uses SQLite with WAL enabled'), existing).action,
    ).toBe('inserted');
  });

  it('folds sources so evidence accumulates', () => {
    const existing = [stored('e1', 'decision', 'storage uses SQLite with WAL enabled')];
    const result = mergeCandidates(
      [candidate('decision', 'storage uses SQLite, WAL enabled', { sourceEventIds: [7, 8] })],
      existing,
    );

    expect(result.inserted).toHaveLength(0);
    expect(result.foldedSources['e1']).toEqual([7, 8]);
  });

  it('does not insert the same candidate twice within a batch', () => {
    const result = mergeCandidates(
      [
        candidate('decision', 'storage uses SQLite with WAL enabled'),
        candidate('decision', 'storage uses SQLite, WAL enabled'),
      ],
      [],
    );

    expect(result.inserted).toHaveLength(1);
    expect(result.duplicates).toHaveLength(1);
  });
});

describe('since you last looked', () => {
  it('says so in one line when nothing changed, so reading can stop', () => {
    const brief = buildBrief(
      input({
        entries: [stored('e1', 'decision', 'uses SQLite')],
        entryTimes: { e1: 500 },
        lastSeenAt: 1_000,
      }),
    );

    expect(brief.nothingNew).toBe(true);
    expect(brief.sections[0]?.lines).toEqual(['Nothing has changed since you last looked.']);
    expect(brief.headline).toContain('nothing new');
  });

  it('lists only what arrived after the last look', () => {
    const brief = buildBrief(
      input({
        entries: [
          stored('old', 'decision', 'an old decision'),
          stored('new', 'decision', 'a new decision'),
        ],
        entryTimes: { old: 500, new: 2_000 },
        lastSeenAt: 1_000,
      }),
    );

    expect(brief.unseenCount).toBe(1);
    expect(brief.sections[0]?.lines.join(' ')).toContain('a new decision');
    expect(brief.sections[0]?.lines.join(' ')).not.toContain('an old decision');
  });

  it('puts a reversal first, because it is the most dangerous state', () => {
    const brief = buildBrief(
      input({
        entries: [
          stored('r', 'decision', 'no longer uses SQLite', { supersededBy: null }),
          stored('d', 'decision', 'the API returns 409', {}),
          stored('rev', 'assumption', 'the schema is append-only', { supersededBy: 'x' }),
        ],
        entryTimes: { r: 2_000, d: 2_000, rev: 2_000 },
        lastSeenAt: 1_000,
      }),
    );

    // The operator accepted something now known to be false.
    expect(brief.sections[0]?.lines[0]).toContain('REVERSED');
  });

  it('treats a never-opened card as all new', () => {
    const brief = buildBrief(
      input({ lastSeenAt: null, entries: [stored('e1', 'decision', 'x')], entryTimes: { e1: 1 } }),
    );

    expect(brief.nothingNew).toBe(false);
    expect(brief.sections[0]?.lines[0]).toContain('not opened this card before');
  });
});

describe('the rest of the brief', () => {
  it('reports the verify result the board ran, not the agent claim', () => {
    const brief = buildBrief(
      input({
        verify: {
          status: 'failed',
          command: 'npm test',
          exitCode: 1,
          output: '2 failing',
          durationMs: 900,
          cwd: '/x',
        },
      }),
    );

    expect(renderBrief(brief)).toContain('Verify did NOT pass');
  });

  it('names files changed that no tool event mentioned', () => {
    const brief = buildBrief(
      input({ changedFiles: ['a.ts', 'b.ts'], changedButUnmentioned: ['b.ts'] }),
    );

    const text = renderBrief(brief);
    expect(text).toContain('2 file(s) changed');
    expect(text).toContain('without appearing in the event stream');
  });

  it('says plainly when the agent memory was compacted', () => {
    expect(renderBrief(buildBrief(input({ compactions: 2 })))).toContain(
      'is a summary, not the original',
    );
  });

  it('excludes a superseded assumption from assumptions in force', () => {
    const brief = buildBrief(
      input({
        entries: [
          stored('a1', 'assumption', 'still true'),
          stored('a2', 'assumption', 'no longer true', { supersededBy: 'a3' }),
        ],
        entryTimes: { a1: 1, a2: 1 },
      }),
    );

    const section = brief.sections.find((s) => s.title === 'Assumptions in force');
    expect(section?.lines.join(' ')).toContain('still true');
    expect(section?.lines.join(' ')).not.toContain('no longer true');
  });

  it('keeps empty sections rather than dropping them silently', () => {
    const brief = buildBrief(input());
    const titles = brief.sections.map((section) => section.title);

    expect(titles).toContain('Decisions');
    expect(brief.sections.filter((section) => section.empty).length).toBeGreaterThan(0);
  });

  it('puts since-you-last-looked first', () => {
    expect(buildBrief(input()).sections[0]?.title).toBe('Since you last looked');
  });

  it('mentions the branch, since the work is not merged', () => {
    expect(renderBrief(buildBrief(input({ branch: 'gorilla/ingest-1a2b' })))).toContain(
      'has not been merged',
    );
  });
});
