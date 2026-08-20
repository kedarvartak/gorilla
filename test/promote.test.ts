import { describe, expect, it } from 'vitest';

import { promoteToGuardrail, PromotionError, suggestRule } from '../src/server/ledger/promote.js';
import { EMPTY_GUARDRAILS, describeGuardrails } from '../src/server/cards/guardrails.js';
import type { StoredEntry } from '../src/server/ledger/dedupe.js';

/**
 * Turning a judged entry into a rule (doc 12, output 1).
 *
 * The step that makes judgement compound: an accepted assumption reaches the
 * next run as context and evaporates, while a guardrail constrains. What has to
 * survive is the distinction between the two, because an operator shown an
 * enforced rule the board cannot enforce has been told a protection exists that
 * does not (R10).
 */

function entry(over: Partial<StoredEntry> = {}): StoredEntry {
  return {
    id: 'e1',
    kind: 'assumption',
    statement: 'The exporter is only called from the CLI',
    sourceEventIds: [1],
    origin: 'model',
    supersededBy: null,
    operatorStatus: 'accepted',
    promotedTo: null,
    ...over,
  };
}

describe('who may promote what', () => {
  it('refuses an entry nobody has read', () => {
    // An unreviewed entry is the model's claim. Promoting one would let the
    // ledger constrain the agent by itself, which doc 12 never allows.
    expect(() =>
      promoteToGuardrail(EMPTY_GUARDRAILS, {
        entry: entry({ operatorStatus: 'unreviewed' }),
        target: 'prohibit',
        rule: 'src/db/schema.ts',
      }),
    ).toThrow(PromotionError);
  });

  it('refuses one the operator rejected', () => {
    expect(() =>
      promoteToGuardrail(EMPTY_GUARDRAILS, {
        entry: entry({ operatorStatus: 'rejected' }),
        target: 'prohibit',
        rule: 'x',
      }),
    ).toThrow(/accepted/);
  });

  it('accepts a corrected entry, which is the operator’s own wording', () => {
    const result = promoteToGuardrail(EMPTY_GUARDRAILS, {
      entry: entry({ operatorStatus: 'corrected' }),
      target: 'scope',
      rule: 'src/export/',
    });

    expect(result.guardrails.scope).toEqual(['src/export/']);
  });

  it('refuses to promote the same entry twice', () => {
    expect(() =>
      promoteToGuardrail(EMPTY_GUARDRAILS, {
        entry: entry({ promotedTo: 'src/db/schema.ts' }),
        target: 'prohibit',
        rule: 'src/db/schema.ts',
      }),
    ).toThrow(/already/);
  });

  it('refuses an empty rule', () => {
    expect(() =>
      promoteToGuardrail(EMPTY_GUARDRAILS, { entry: entry(), target: 'prohibit', rule: '   ' }),
    ).toThrow(/something to say/);
  });
});

describe('what the operator is told they got', () => {
  it('reports a path prohibition as enforced', () => {
    const result = promoteToGuardrail(EMPTY_GUARDRAILS, {
      entry: entry(),
      target: 'prohibit',
      rule: 'src/db/schema.ts',
    });

    expect(result.enforcement).toBe('hard');
    expect(result.detail).toContain('deny rule');
    // And the card agrees, which is what the interface renders.
    expect(describeGuardrails(result.guardrails).some((rail) => rail.enforcement === 'hard')).toBe(
      true,
    );
  });

  it('reports advice as advice, rather than as a protection', () => {
    const result = promoteToGuardrail(EMPTY_GUARDRAILS, {
      entry: entry(),
      target: 'prohibit',
      rule: 'do not over-engineer the exporter',
    });

    // The failure this exists to avoid: an operator who believes this is
    // enforced will dispatch a card trusting something that is only prompt text.
    expect(result.enforcement).toBe('advisory');
    expect(result.detail).toContain('rests on');
  });

  it('says scope never stops anything', () => {
    const result = promoteToGuardrail(EMPTY_GUARDRAILS, {
      entry: entry(),
      target: 'scope',
      rule: 'src/export/',
    });

    expect(result.enforcement).toBe('advisory');
    expect(result.detail).toContain('does not stop it');
  });

  it('names the verify command it will run', () => {
    const result = promoteToGuardrail(EMPTY_GUARDRAILS, {
      entry: entry(),
      target: 'verify',
      rule: 'npm test',
    });

    expect(result.enforcement).toBe('hard');
    expect(result.guardrails.verify).toBe('npm test');
    expect(result.detail).toContain('after every run');
  });

  it('says so when a verify command replaces another', () => {
    // One verify per card. Two would mean the board silently choosing which
    // one counts, so the replacement is stated rather than done quietly.
    const result = promoteToGuardrail(
      { ...EMPTY_GUARDRAILS, verify: 'npm run old' },
      { entry: entry(), target: 'verify', rule: 'npm test' },
    );

    expect(result.detail).toContain('npm run old');
  });
});

describe('not adding the same rule twice', () => {
  it('refuses a prohibition already on the card', () => {
    expect(() =>
      promoteToGuardrail(
        { ...EMPTY_GUARDRAILS, prohibit: ['src/db/schema.ts'] },
        { entry: entry(), target: 'prohibit', rule: 'src/db/schema.ts' },
      ),
    ).toThrow(/already on this card/);
  });

  it('refuses a scope path already in scope', () => {
    expect(() =>
      promoteToGuardrail(
        { ...EMPTY_GUARDRAILS, scope: ['src/'] },
        { entry: entry(), target: 'scope', rule: 'src/' },
      ),
    ).toThrow(/already in scope/);
  });
});

describe('the suggested rule', () => {
  it('offers the file for a prohibition about one file', () => {
    // The enforceable case, so the one worth pre-filling.
    expect(suggestRule(entry({ filePaths: ['src/export/run.ts'] }), 'prohibit')).toBe(
      'src/export/run.ts',
    );
  });

  it('offers nothing when the entry names several files', () => {
    // Which of them the rule is about is a judgement, and guessing would put
    // words in the operator's mouth.
    expect(suggestRule(entry({ filePaths: ['a.ts', 'b.ts'] }), 'prohibit')).toBe('');
  });

  it('offers nothing at all for a verify command', () => {
    // A statement about what happened cannot be turned into a command to run.
    expect(suggestRule(entry(), 'verify')).toBe('');
  });
});
