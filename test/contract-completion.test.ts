import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  describeVerdict,
  maySettle,
  readReport,
  REPORT_PATH,
  type BoardEvidence,
} from '../src/server/review/contract.js';

/**
 * The completion contract.
 *
 * The claim under test is that a card cannot settle on an agent's own "done".
 * Four terms, all required, and `outstanding` required even when empty -
 * because an omitted field and nothing to report are otherwise the same bytes.
 */

let dir: string;

const EVIDENCE: BoardEvidence = {
  changedPaths: ['src/auth/session.ts'],
  verifyStatus: 'passed',
};

const GOOD = {
  summary: 'Expired reset tokens are now rejected at the endpoint.',
  files: [{ path: 'src/auth/session.ts', why: 'Rejects a token past its expiry.' }],
  verification: {
    how: 'npm test test/auth',
    result: '14 passing',
    evidence: 'test-output.log',
  },
  outstanding: [],
};

function report(body: unknown): string {
  const path = join(dir, REPORT_PATH);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(body));
  return dir;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gorilla-contract-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('what the board accepts as a finished card', () => {
  it('accepts a complete account', () => {
    const verdict = maySettle(GOOD, EVIDENCE);

    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(verdict.report.summary).toContain('Expired reset tokens');
    expect(verdict.report.outstanding).toEqual([]);
  });

  it('refuses a run that left no report at all', () => {
    const verdict = maySettle(null, EVIDENCE);

    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.missing).toEqual(['summary', 'files', 'verification', 'outstanding']);
  });

  it('refuses a report that omits what is outstanding', () => {
    const withoutOutstanding: Record<string, unknown> = { ...GOOD };
    delete withoutOutstanding.outstanding;
    const verdict = maySettle(withoutOutstanding, EVIDENCE);

    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.missing).toEqual(['outstanding']);
  });

  it('accepts an empty list, because saying there is nothing is saying something', () => {
    expect(maySettle({ ...GOOD, outstanding: [] }, EVIDENCE).ok).toBe(true);
  });

  it('refuses files listed without a reason, which is a diff rather than an account', () => {
    const verdict = maySettle({ ...GOOD, files: [{ path: 'src/auth/session.ts' }] }, EVIDENCE);

    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.missing).toContain('files');
  });

  it('refuses a verification with no result', () => {
    const verdict = maySettle(
      { ...GOOD, verification: { how: 'npm test', evidence: null } },
      EVIDENCE,
    );

    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.missing).toContain('verification');
  });

  it('refuses an account of work the branch does not contain', () => {
    const verdict = maySettle(GOOD, {
      changedPaths: ['src/billing/invoice.ts'],
      verifyStatus: 'passed',
    });

    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.why).toContain('names no file the branch actually changed');
  });

  it('accepts a directory named for a file inside it', () => {
    const verdict = maySettle(
      { ...GOOD, files: [{ path: 'src/auth/', why: 'Token expiry handling.' }] },
      EVIDENCE,
    );

    expect(verdict.ok).toBe(true);
  });

  it('does not count its own report file as work the account failed to describe', () => {
    const verdict = maySettle(GOOD, {
      changedPaths: ['src/auth/session.ts', `.gorilla/${'report.json'}`],
      verifyStatus: 'passed',
    });

    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    // Otherwise every card carries one discrepancy, and a card whose only
    // change was the report would be refused on the strength of the report.
    expect(verdict.discrepancies).toEqual([]);
  });

  it('records an undescribed change without refusing the report over it', () => {
    const verdict = maySettle(GOOD, {
      changedPaths: ['src/auth/session.ts', 'package-lock.json'],
      verifyStatus: 'passed',
    });

    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(verdict.discrepancies).toEqual([
      'package-lock.json was changed and the report does not mention it.',
    ]);
  });
});

describe('reading the report off a worktree', () => {
  it('reads what the agent wrote', () => {
    expect(maySettle(readReport(report(GOOD)), EVIDENCE).ok).toBe(true);
  });

  it('treats malformed JSON as a missing report rather than throwing', () => {
    mkdirSync(join(dir, '.gorilla'), { recursive: true });
    writeFileSync(join(dir, REPORT_PATH), '{ this is not json');

    expect(readReport(dir)).toBeNull();
    expect(maySettle(readReport(dir), EVIDENCE).ok).toBe(false);
  });

  it('tells the agent how to satisfy the contract, not merely that it failed', () => {
    const described = describeVerdict(maySettle(null, EVIDENCE));

    expect(described).toContain(REPORT_PATH);
    expect(described).toContain('outstanding');
    expect(described).toContain('empty');
  });
});
