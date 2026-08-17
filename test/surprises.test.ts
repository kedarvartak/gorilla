import { describe, expect, it } from 'vitest';

import type { StoredEntry } from '../src/server/ledger/dedupe.js';
import { surprisesFor } from '../src/server/ledger/surprises.js';

/**
 * The surprise set is the primitive every enforcement layer hangs off, so what
 * it *excludes* is as much the subject of these tests as what it includes. An
 * ordinary decision not appearing is not a gap in coverage; it is the rule.
 */

const CARD = 'card-1';

function entry(extra: Partial<StoredEntry> = {}): StoredEntry {
  return {
    id: 'e1',
    kind: 'decision',
    statement: 'Stored the ledger in SQLite',
    alternative: 'flat JSON files on disk',
    filePaths: ['src/db.ts'],
    sourceEventIds: [7],
    origin: 'model',
    supersededBy: null,
    operatorStatus: 'unreviewed',
    ...extra,
  };
}

function surprises(
  entries: readonly StoredEntry[],
  changedButUnmentioned: readonly string[] = [],
): ReturnType<typeof surprisesFor> {
  return surprisesFor({ cardId: CARD, entries, changedButUnmentioned });
}

describe('the surprise set', () => {
  it('is empty for a card with nothing outstanding', () => {
    expect(surprises([entry()])).toEqual([]);
    expect(surprises([])).toEqual([]);
  });

  it('reports a superseded entry', () => {
    const result = surprises([entry({ supersededBy: 'e2' })]);

    expect(result).toHaveLength(1);
    expect(result[0]?.kind).toBe('superseded');
    expect(result[0]?.headline).toContain('SQLite');
    expect(result[0]?.target).toEqual({ type: 'entry', entryId: 'e1' });
  });

  it('reports an assumption', () => {
    const result = surprises([
      entry({
        kind: 'assumption',
        statement: 'The migration already ran in production',
        detail: 'Never confirmed against the deployed schema.',
      }),
    ]);

    expect(result).toHaveLength(1);
    expect(result[0]?.kind).toBe('assumption');
    expect(result[0]?.detail).toBe('Never confirmed against the deployed schema.');
  });

  it('leaves an ordinary decision out', () => {
    // The whole value of the set is that it is short. A decision with its
    // alternative recorded is good ledger content and optional reading.
    expect(surprises([entry(), entry({ id: 'e2', kind: 'risk' })])).toEqual([]);
  });

  it('drops an entry the operator has acknowledged', () => {
    expect(surprises([entry({ kind: 'assumption', operatorStatus: 'accepted' })])).toEqual([]);
    expect(surprises([entry({ supersededBy: 'e2', operatorStatus: 'rejected' })])).toEqual([]);
  });

  it('treats an entry with no recorded status as unreviewed', () => {
    const { operatorStatus: _omitted, ...withoutStatus } = entry({ kind: 'assumption' });

    expect(surprises([withoutStatus])).toHaveLength(1);
  });

  it('reports one item per file that changed without being mentioned', () => {
    const result = surprises([], ['src/quiet.ts', 'src/loud.ts', 'src/quiet.ts']);

    expect(result.map((item) => item.kind)).toEqual(['unmentioned-change', 'unmentioned-change']);
    expect(result.map((item) => item.target)).toEqual([
      { type: 'path', path: 'src/quiet.ts' },
      { type: 'path', path: 'src/loud.ts' },
    ]);
    expect(result[0]?.headline).toContain('src/quiet.ts');
    expect(result[0]?.filePaths).toEqual(['src/quiet.ts']);
  });

  it('counts an entry that is both superseded and an assumption once', () => {
    const result = surprises([entry({ kind: 'assumption', supersededBy: 'e2' })]);

    expect(result).toHaveLength(1);
    expect(result[0]?.kind).toBe('superseded');
  });

  it('gives every item a distinct id and enough to render it', () => {
    const result = surprises(
      [entry({ kind: 'assumption' }), entry({ id: 'e2', supersededBy: 'e3' })],
      ['src/quiet.ts'],
    );

    expect(new Set(result.map((item) => item.id)).size).toBe(3);
    for (const item of result) {
      expect(item.cardId).toBe(CARD);
      expect(item.headline.length).toBeGreaterThan(0);
      expect(item.why.length).toBeGreaterThan(0);
    }
  });
});
