import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { assessStaleness, claimedPaths, mergedPaths } from '../src/server/cards/staleness.js';
import { EMPTY_GUARDRAILS, parseGuardrails } from '../src/server/cards/guardrails.js';

/**
 * Whether a card still describes work that needs doing.
 *
 * Written after losing three cards to this in one batch: two described modules
 * that had shipped weeks earlier and one duplicated an endpoint another card had
 * already built. Dispatching any would have spent a run rebuilding what existed.
 *
 * Every assertion here is about not crying wolf. A board that flags healthy
 * cards trains the operator to ignore the flag, at which point it is worse than
 * having none.
 */

let dir: string;

const rails = (json: Record<string, unknown>) => parseGuardrails(JSON.stringify(json));

function base(over: Partial<Parameters<typeof assessStaleness>[0]> = {}) {
  return {
    cardTitle: 'A card',
    body: '',
    guardrails: EMPTY_GUARDRAILS,
    runCount: 0,
    repoCwd: dir,
    merged: [],
    ...over,
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gorilla-stale-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('finding the paths a card names', () => {
  it('reads them from scope', () => {
    const paths = claimedPaths({
      guardrails: rails({ scope: ['src/server/ledger/dedupe.ts', 'test/'] }),
      body: '',
    });

    expect(paths).toContain('src/server/ledger/dedupe.ts');
  });

  it('reads them from the body, where cards actually name files', () => {
    const paths = claimedPaths({
      guardrails: EMPTY_GUARDRAILS,
      body: 'setOperatorStatus exists in `src/server/ledger/store.ts` and nothing reaches it.',
    });

    expect(paths).toEqual(['src/server/ledger/store.ts']);
  });

  it('does not mistake prose for a path', () => {
    // "the ledger" and "doc 08" are not files, and treating them as such would
    // produce the false positives this module is shaped to avoid.
    const paths = claimedPaths({
      guardrails: EMPTY_GUARDRAILS,
      body: 'Compare candidate entries against existing ones. See doc 08, section 2.',
    });

    expect(paths).toEqual([]);
  });
});

describe('the suspicion', () => {
  it('raises when every file a card names already exists and it never ran', () => {
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'dedupe.ts'), 'export const done = true;\n');

    const verdict = assessStaleness(
      base({ body: 'Implement `src/dedupe.ts`.', guardrails: rails({ scope: ['src/dedupe.ts'] }) }),
    );

    expect(verdict.suspect).toBe(true);
    expect(verdict.findings[0]?.signal).toBe('targets-exist');
    // The evidence is what makes it checkable rather than believable.
    expect(verdict.findings[0]?.evidence).toContain('src/dedupe.ts');
    expect(verdict.advice).toContain('mark it done');
  });

  it('stays quiet when the files do not exist yet', () => {
    const verdict = assessStaleness(
      base({ body: 'Create `src/not-yet.ts`.', guardrails: rails({ scope: ['src/not-yet.ts'] }) }),
    );

    expect(verdict.suspect).toBe(false);
  });

  it('stays quiet for a card that has already run', () => {
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'thing.ts'), 'x\n');

    // A card with runs is in progress or finished, and its own history explains
    // it better than any inference here.
    const verdict = assessStaleness(
      base({ runCount: 2, guardrails: rails({ scope: ['src/thing.ts'] }) }),
    );

    expect(verdict.suspect).toBe(false);
  });

  it('stays quiet for a card that names no files at all', () => {
    // Absence of a signal is not a signal. Guessing from prose is how a checker
    // like this starts crying wolf.
    const verdict = assessStaleness(base({ body: 'Make the ledger nicer to read.' }));
    expect(verdict.suspect).toBe(false);
  });

  it('does not raise on a shared verify command alone', () => {
    const verdict = assessStaleness(
      base({
        guardrails: rails({ verify: 'npm test' }),
        merged: [{ title: 'Something else', verify: 'npm test', paths: [] }],
      }),
    );

    // One test suite means every card shares a verify command. Flagging that
    // would flag everything, and a flag on everything is noise.
    expect(verdict.suspect).toBe(false);
    expect(verdict.findings.map((finding) => finding.signal)).toContain('duplicate-verify');
  });

  it('reports an overlap with merged work as context, not alarm', () => {
    const verdict = assessStaleness(
      base({
        body: 'Change `src/server/brief.ts`.',
        merged: [{ title: 'The brief', verify: null, paths: ['src/server/brief.ts'] }],
      }),
    );

    expect(verdict.findings.map((finding) => finding.signal)).toContain('overlaps-merged');
    // The file does not exist here, so the reliable signal is absent and this
    // one does not raise on its own.
    expect(verdict.suspect).toBe(false);
  });

  it('survives a repository that is not there', () => {
    const verdict = assessStaleness(
      base({ repoCwd: join(dir, 'absent'), guardrails: rails({ scope: ['src/x.ts'] }) }),
    );

    expect(verdict.suspect).toBe(false);
  });
});

describe('what a merged card changed', () => {
  it('lists the files from its branch', async () => {
    const repo = join(dir, 'repo');
    execFileSync('git', ['init', '-q', '-b', 'main', repo]);
    execFileSync('git', ['config', 'user.email', 't@example.com'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'T'], { cwd: repo });
    writeFileSync(join(repo, 'seed.txt'), 'seed\n');
    execFileSync('git', ['add', '.'], { cwd: repo });
    execFileSync('git', ['commit', '-qm', 'initial'], { cwd: repo });

    execFileSync('git', ['checkout', '-q', '-b', 'gorilla/card'], { cwd: repo });
    writeFileSync(join(repo, 'added.ts'), 'export const x = 1;\n');
    execFileSync('git', ['add', '.'], { cwd: repo });
    execFileSync('git', ['commit', '-qm', 'work'], { cwd: repo });
    execFileSync('git', ['checkout', '-q', 'main'], { cwd: repo });

    expect(await mergedPaths(repo, 'gorilla/card')).toEqual(['added.ts']);
  });

  it('is empty for a branch that has been deleted', async () => {
    // The normal end state of a merged card, so this is an expected miss rather
    // than a failure to report.
    expect(await mergedPaths(dir, 'gorilla/gone')).toEqual([]);
    expect(await mergedPaths(dir, null)).toEqual([]);
  });
});
