import { describe, expect, it } from 'vitest';

import {
  createNonce,
  gradeAnswer,
  summarise,
  viability,
  type ProbeFindings,
} from '../src/probe/compaction.js';

const nonce = createNonce(() => 'a'.repeat(32));

function findings(overrides: Partial<ProbeFindings> = {}): ProbeFindings {
  return {
    preCompactFired: true,
    transcriptReadableAtPreCompact: true,
    transcriptTailChars: 80,
    sessionStartCompactFired: false,
    injectionVerdict: 'received',
    nonce: nonce.value,
    answer: nonce.value,
    observations: [
      { event: 'command:SessionStart', matcher: 'startup', at: 1 },
      { event: 'http:Stop', matcher: null, at: 2 },
    ],
    ...overrides,
  };
}

describe('createNonce', () => {
  it('produces an unguessable value the question refers to', () => {
    expect(nonce.value).toBe(`GORILLA-${'A'.repeat(32)}`);
    expect(nonce.injection).toContain(nonce.value);
    expect(nonce.question).toContain('NO-CODE-RECEIVED');
    // The question must not contain the answer.
    expect(nonce.question).not.toContain(nonce.value);
  });

  it('is different every time by default', () => {
    expect(createNonce().value).not.toBe(createNonce().value);
  });

  it('carries enough entropy that a lucky guess is not an explanation', () => {
    expect(createNonce().value.length).toBeGreaterThanOrEqual(8 + 32);
  });
});

describe('gradeAnswer', () => {
  it('accepts the exact nonce', () => {
    expect(gradeAnswer(nonce.value, nonce)).toBe('received');
    expect(gradeAnswer(`  ${nonce.value.toLowerCase()}  `, nonce)).toBe('received');
    expect(gradeAnswer(`The code is ${nonce.value}.`, nonce)).toBe('received');
  });

  it('accepts an explicit denial as absent', () => {
    expect(gradeAnswer('NO-CODE-RECEIVED', nonce)).toBe('absent');
  });

  it('treats anything else as inconclusive rather than a clean negative', () => {
    // The failure mode this guards: a model that produces something plausible.
    expect(gradeAnswer('I do not appear to have been given a code.', nonce)).toBe('inconclusive');
    expect(gradeAnswer('GORILLA-0000000000000000', nonce)).toBe('inconclusive');
    expect(gradeAnswer('', nonce)).toBe('inconclusive');
  });
});

describe('viability', () => {
  it('is blocked only when the channel failed', () => {
    expect(viability(findings({ injectionVerdict: 'absent' }))).toBe('blocked');
    expect(viability(findings({ injectionVerdict: 'inconclusive' }))).toBe('blocked');
  });

  it('is unproven when the channel works but the compact source was not seen', () => {
    expect(viability(findings({ sessionStartCompactFired: false }))).toBe('unproven');
  });

  it('is viable when both hold', () => {
    expect(viability(findings({ sessionStartCompactFired: true }))).toBe('viable');
  });
});

describe('summarise', () => {
  it('reports which transport saw SessionStart', () => {
    const output = summarise(findings());

    expect(output).toContain('SessionStart over command hook:      YES');
    expect(output).toContain('SessionStart over http hook:         NO');
  });

  it('does not claim failure when the channel works', () => {
    const output = summarise(findings({ sessionStartCompactFired: false }));

    expect(output).toContain('The injection channel works');
    expect(output).not.toContain('needs its fallback path');
  });

  it('says plainly when the channel failed', () => {
    expect(summarise(findings({ injectionVerdict: 'absent' }))).toContain(
      'needs its fallback path',
    );
  });
});
