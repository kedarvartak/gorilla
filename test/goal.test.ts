import { describe, expect, it } from 'vitest';

import {
  checkCondition,
  composeAndCheck,
  composeCondition,
  hasBound,
  hasVerifiableCheck,
  judgementPhrasesIn,
  MAX_CONDITION_LENGTH,
} from '../src/server/goal/compose.js';
import { EMPTY_GUARDRAILS } from '../src/server/cards/guardrails.js';

const codes = (condition: string): string[] => checkCondition(condition).map((w) => w.code);

describe('composeCondition', () => {
  it('builds the doc 07 structure: end state, check, constraints, bound', () => {
    const condition = composeCondition({
      endState: 'every test in test/auth passes',
      verify: 'npm test',
      guardrails: {
        ...EMPTY_GUARDRAILS,
        prohibit: ['src/db/schema.ts'],
        scope: ['src/auth/'],
      },
      maxTurns: 20,
    });

    expect(condition).toContain('every test in test/auth passes');
    expect(condition).toContain('`npm test`');
    expect(condition).toContain('without modifying src/db/schema.ts');
    expect(condition).toContain('changing only src/auth/');
    expect(condition).toContain('stop after 20 turns');
  });

  it('omits sections the card does not supply', () => {
    const condition = composeCondition({ endState: 'the build succeeds' });

    expect(condition).toBe('the build succeeds.');
    expect(condition).not.toContain('without modifying');
    expect(condition).not.toContain('stop after');
  });

  it('takes the bound from the guardrails when not given directly', () => {
    const condition = composeCondition({
      endState: 'x',
      guardrails: { ...EMPTY_GUARDRAILS, maxTurns: 5 },
    });
    expect(condition).toContain('stop after 5 turns');
  });

  it('does not double the terminating punctuation', () => {
    expect(composeCondition({ endState: 'the build succeeds.' })).toBe('the build succeeds.');
  });
});

describe('hasVerifiableCheck', () => {
  it.each([
    'npm test exits 0',
    'the build passes',
    'running `pytest -q` shows no failures',
    'tsc reports no errors',
    'the endpoint returns 200',
  ])('accepts %j', (condition) => {
    expect(hasVerifiableCheck(condition)).toBe(true);
  });

  it.each(['the code is nicer', 'the module has been refactored', 'everything is finished'])(
    'rejects %j',
    (condition) => {
      expect(hasVerifiableCheck(condition)).toBe(false);
    },
  );
});

describe('checkCondition', () => {
  it('warns when nothing the evaluator can read would demonstrate the goal', () => {
    // The core trap: the evaluator does not run commands.
    expect(codes('the authentication module has been refactored')).toContain('no-verifiable-check');
  });

  it('does not warn when a check is named', () => {
    expect(codes('`npm test` exits 0, or stop after 10 turns')).not.toContain(
      'no-verifiable-check',
    );
  });

  it('warns when the goal has no bound', () => {
    expect(codes('`npm test` exits 0')).toContain('no-bound');
    expect(codes('`npm test` exits 0, or stop after 20 turns')).not.toContain('no-bound');
  });

  it('errors when the condition exceeds the documented cap', () => {
    const warnings = checkCondition('x'.repeat(MAX_CONDITION_LENGTH + 1));
    const tooLong = warnings.find((warning) => warning.code === 'too-long');

    expect(tooLong?.severity).toBe('error');
  });

  it('errors on an empty condition and says nothing else', () => {
    expect(codes('   ')).toEqual(['empty']);
  });

  it('warns about qualities the evaluator cannot settle', () => {
    const warnings = checkCondition('the code is clean and idiomatic, and `npm test` passes');
    const judgement = warnings.find((warning) => warning.code === 'asks-for-judgement');

    expect(judgement?.message).toContain('clean');
    expect(judgement?.message).toContain('idiomatic');
  });

  it('gives a remedy for every warning, not just a complaint', () => {
    for (const warning of checkCondition('make the code nicer')) {
      expect(warning.remedy.length).toBeGreaterThan(10);
    }
  });

  it('never rewrites the operator’s text', () => {
    const original = 'make the code nicer';
    checkCondition(original);
    // Warning only: silently correcting would leave the operator believing the
    // agent is working toward something it is not.
    expect(original).toBe('make the code nicer');
  });
});

describe('judgementPhrasesIn', () => {
  it('finds each offending phrase', () => {
    expect(judgementPhrasesIn('production-ready and maintainable')).toEqual(
      expect.arrayContaining(['production-ready', 'maintainable']),
    );
  });

  it('finds none in an observable condition', () => {
    expect(judgementPhrasesIn('`npm test` exits 0')).toEqual([]);
  });
});

describe('hasBound', () => {
  it.each(['stop after 20 turns', 'within 10 turns', 'at most 5 turns', 'no more than 3 turns'])(
    'recognises %j',
    (text) => {
      expect(hasBound(text)).toBe(true);
    },
  );
});

describe('composeAndCheck', () => {
  it('produces a usable condition for a well-specified card', () => {
    const result = composeAndCheck({
      endState: 'every test in test/auth passes',
      verify: 'npm test',
      guardrails: { ...EMPTY_GUARDRAILS, maxTurns: 20 },
    });

    expect(result.usable).toBe(true);
    expect(result.warnings.filter((w) => w.severity === 'error')).toHaveLength(0);
    expect(result.length).toBeLessThan(MAX_CONDITION_LENGTH);
  });

  it('marks a condition unusable when an error is present', () => {
    const result = composeAndCheck({ endState: 'x'.repeat(MAX_CONDITION_LENGTH + 10) });
    expect(result.usable).toBe(false);
  });

  it('still returns the condition alongside its warnings', () => {
    const result = composeAndCheck({ endState: 'make it clean' });

    expect(result.condition).toContain('make it clean');
    expect(result.warnings.length).toBeGreaterThan(0);
    // Warnings do not suppress the output; the operator decides.
    expect(result.usable).toBe(true);
  });
});
