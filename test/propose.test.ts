import { describe, expect, it } from 'vitest';

import { EMPTY_GUARDRAILS } from '../src/server/cards/guardrails.js';
import type { StoredEntry } from '../src/server/ledger/dedupe.js';
import { proposeGuardrails } from '../src/server/ledger/propose.js';

/**
 * Proposing a rule from what the runs established (T14).
 *
 * The promotion machinery has existed since G1 and has never been used, because
 * finding a candidate meant reading everything the ledger holds. This is the
 * shortlist. It proposes and never applies.
 */

function entry(overrides: Partial<StoredEntry> & { statement: string }): StoredEntry {
  return {
    id: 'entry-1',
    kind: 'assumption',
    sourceEventIds: [1],
    origin: 'model',
    operatorStatus: 'accepted',
    promotedTo: null,
    ...overrides,
  };
}

describe('what gets shortlisted', () => {
  it('proposes a prohibition from a statement phrased as one', () => {
    const proposals = proposeGuardrails(
      [entry({ statement: 'Never edit the generated migration snapshots by hand.' })],
      EMPTY_GUARDRAILS,
    );

    expect(proposals).toHaveLength(1);
    expect(proposals[0]?.target).toBe('prohibit');
  });

  it('proposes a verify rule from a statement about a check', () => {
    const proposals = proposeGuardrails(
      [entry({ statement: '`npm test` must pass before this card is done.' })],
      EMPTY_GUARDRAILS,
    );

    expect(proposals[0]?.target).toBe('verify');
  });

  it('ignores an entry the operator has not accepted', () => {
    // An unreviewed entry is the model's claim. Shortlisting it invites
    // promoting a rule nobody has read, which is the one thing doc 12 does not
    // allow the ledger to do.
    const proposals = proposeGuardrails(
      [entry({ statement: 'Never touch the schema.', operatorStatus: 'unreviewed' })],
      EMPTY_GUARDRAILS,
    );

    expect(proposals).toEqual([]);
  });

  it('ignores an entry that was rejected', () => {
    const proposals = proposeGuardrails(
      [entry({ statement: 'Never touch the schema.', operatorStatus: 'rejected' })],
      EMPTY_GUARDRAILS,
    );

    expect(proposals).toEqual([]);
  });

  it('does not offer the same entry twice', () => {
    const proposals = proposeGuardrails(
      [entry({ statement: 'Never touch the schema.', promotedTo: 'src/db/schema.ts' })],
      EMPTY_GUARDRAILS,
    );

    expect(proposals).toEqual([]);
  });

  it('does not propose a rule the card already has', () => {
    const proposals = proposeGuardrails(
      [entry({ statement: 'Never edit it.', filePaths: ['src/db/schema.ts'] })],
      { ...EMPTY_GUARDRAILS, prohibit: ['src/db/schema.ts'] },
    );

    expect(proposals).toEqual([]);
  });

  it('says nothing about an ordinary observation', () => {
    // A shortlist that includes every accepted assumption is a list nobody
    // reads, and therefore not a shortlist.
    const proposals = proposeGuardrails(
      [entry({ statement: 'The exporter is called from the CLI.' })],
      EMPTY_GUARDRAILS,
    );

    expect(proposals).toEqual([]);
  });
});

describe('what the proposal promises', () => {
  it('calls a path-shaped prohibition enforceable', () => {
    const proposals = proposeGuardrails(
      [entry({ statement: 'Never edit it.', filePaths: ['src/db/schema.ts'] })],
      EMPTY_GUARDRAILS,
    );

    expect(proposals[0]?.enforcement).toBe('hard');
    expect(proposals[0]?.rule).toBe('src/db/schema.ts');
  });

  it('calls a prose prohibition advisory, and says why', () => {
    const proposals = proposeGuardrails(
      [entry({ statement: 'Never assume the board is the only writer.' })],
      EMPTY_GUARDRAILS,
    );

    // An operator shown 'prohibit' who receives prompt text has been told a
    // protection exists that does not (R10).
    expect(proposals[0]?.enforcement).toBe('advisory');
    expect(proposals[0]?.why).toContain('persuasion');
  });

  it('puts the enforceable ones first', () => {
    const proposals = proposeGuardrails(
      [
        entry({ id: 'soft', statement: 'Never assume the board is the only writer.' }),
        entry({ id: 'hard', statement: 'Never edit it.', filePaths: ['src/db/schema.ts'] }),
      ],
      EMPTY_GUARDRAILS,
    );

    // The operator's time is better spent on promotions that will stop
    // something than on ones that will only ask.
    expect(proposals.map((proposal) => proposal.entryId)).toEqual(['hard', 'soft']);
  });

  it('keeps the operator’s own words when there is no path to use', () => {
    const statement = 'Never run the migration generator without formatting its output.';
    const proposals = proposeGuardrails([entry({ statement })], EMPTY_GUARDRAILS);

    // Inventing a rule the operator did not write is how a promotion ends up
    // saying something nobody agreed to.
    expect(proposals[0]?.rule).toBe(statement);
  });
});
