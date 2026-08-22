import { describe, expect, it } from 'vitest';

import { assessReadiness, type ReadinessInput } from '../src/server/review/readiness.js';

/**
 * What the operator is about to accept (T37).
 *
 * The gate refuses while something is unjudged, which is the right refusal and
 * only half a review. When it lets the merge through, nothing assembled what
 * the run established and what the board could not check.
 */

function input(over: Partial<ReadinessInput> = {}): ReadinessInput {
  return {
    verify: { status: 'passed' },
    verifyCommand: 'npm test',
    outstanding: 0,
    establishedCount: 2,
    diff: { readable: true, files: ['a.ts'] },
    mergeForecast: { readable: true, clean: true },
    blockers: [],
    claimedNotInGit: [],
    ...over,
  };
}

function stateOf(readiness: ReturnType<typeof assessReadiness>, name: string): string | undefined {
  return readiness.checks.find((check) => check.name === name)?.state;
}

describe('a card with nothing outstanding', () => {
  it('is settled', () => {
    expect(assessReadiness(input()).settled).toBe(true);
  });
});

describe('a check the board could not run', () => {
  it('is unknown, not settled', () => {
    // An unrun check and a passed one are the two things this list exists to
    // keep apart.
    const readiness = assessReadiness(input({ verifyCommand: null, verify: null }));

    expect(stateOf(readiness, 'verify')).toBe('unknown');
    expect(readiness.settled).toBe(false);
  });

  it('is unknown when the command exists and never ran', () => {
    expect(stateOf(assessReadiness(input({ verify: null })), 'verify')).toBe('unknown');
  });

  it('is unknown when the branch cannot be read', () => {
    const readiness = assessReadiness(input({ diff: { readable: false, files: [] } }));

    expect(stateOf(readiness, 'diff')).toBe('unknown');
  });
});

describe('what needs the operator', () => {
  it('names a failing verify', () => {
    expect(stateOf(assessReadiness(input({ verify: { status: 'failed' } })), 'verify')).toBe(
      'needs-you',
    );
  });

  it('names unjudged surprises', () => {
    expect(stateOf(assessReadiness(input({ outstanding: 3 })), 'judgements')).toBe('needs-you');
  });

  it('names a conflict without calling it a reason not to merge', () => {
    const readiness = assessReadiness(input({ mergeForecast: { readable: true, clean: false } }));

    // Resolving is part of merging. The board can do it, and saying otherwise
    // would send the operator to a terminal for something it handles.
    expect(readiness.checks.find((check) => check.name === 'conflicts')?.detail).toContain(
      'not a reason not to',
    );
  });

  it('names blocked dependencies', () => {
    expect(stateOf(assessReadiness(input({ blockers: ['card-1'] })), 'dependencies')).toBe(
      'needs-you',
    );
  });

  it('names paths the run mentioned that git did not see', () => {
    const readiness = assessReadiness(input({ claimedNotInGit: ['a.ts'] }));

    // Often innocent, which the wording says rather than implying a lie.
    expect(readiness.checks.find((check) => check.name === 'claims')?.detail).toContain('innocent');
  });
});

describe('what was established', () => {
  it('is never presented as something the board can check', () => {
    // Having read the ledger is not observable. A checklist that claimed to
    // know would be asserting something it cannot see.
    expect(stateOf(assessReadiness(input({ establishedCount: 0 })), 'established')).toBe('settled');
  });

  it('says when nothing has been accepted, and why that is ambiguous', () => {
    const readiness = assessReadiness(input({ establishedCount: 0 }));

    expect(readiness.checks.find((check) => check.name === 'established')?.detail).toContain(
      'nothing has been read',
    );
  });
});
