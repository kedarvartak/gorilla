import { describe, expect, it } from 'vitest';

import {
  buildPrompt,
  DEFAULT_RESYNC_MODEL,
  parseUsage,
  parseVerdicts,
  resolveResyncModel,
  RESYNC_SCHEMA,
  type ResyncSubject,
} from '../src/server/cards/resync-agent.js';

/**
 * Reading what the agent said (issue 173).
 *
 * The spawn is not tested here - it needs a CLI, a login and a repository, and
 * a test that shells out to a model is a test that fails on someone else's
 * machine for reasons that have nothing to do with the code. What is tested is
 * everything either side of it: what the agent is told, and what the board is
 * willing to believe back.
 *
 * The parsing assertions are the load-bearing ones. This output moves cards
 * into Done, so anything malformed reaching the database is a card the
 * operator has to find and put back.
 */

const CARD: ResyncSubject = {
  cardId: 'card-1',
  title: 'Replace the native selects',
  body: 'Every dropdown opens an OS menu.',
  goalCondition: 'No <select> left in src/web/src.',
  paths: ['src/web/src/Board.tsx'],
  status: 'abandoned',
  createdAt: Date.parse('2026-08-01T00:00:00Z'),
  hasRun: false,
};

describe('what the agent is told', () => {
  it('gives it the card, its goal and when it was written', () => {
    const prompt = buildPrompt([CARD]);

    expect(prompt).toContain('cardId: card-1');
    expect(prompt).toContain('Replace the native selects');
    expect(prompt).toContain('No <select> left in src/web/src.');
    // "Since" is meaningless without it, and every rule in the instructions
    // turns on what landed after the card was written.
    expect(prompt).toContain('2026-08-01');
    expect(prompt).toContain('Every dropdown opens an OS menu.');
  });

  it('offers the files it names as a hint rather than as the test', () => {
    const prompt = buildPrompt([CARD]);

    // The rule the previous resync got wrong: it treated the named paths as
    // the whole of the evidence, and confirmed a card because its files had
    // changed for unrelated reasons.
    expect(prompt).toContain('a hint, not the test');
    expect(prompt).toContain('src/web/src/Board.tsx');
    expect(prompt).toContain('A file existing is not the work being done');
  });

  it('tells it what "done" costs, since done stops anyone looking again', () => {
    expect(buildPrompt([CARD])).toContain("moves the card to the board's terminal column");
  });

  it('numbers every card, so a sweep is one prompt', () => {
    const prompt = buildPrompt([CARD, { ...CARD, cardId: 'card-2', title: 'Another' }]);

    expect(prompt).toContain('### Card 1');
    expect(prompt).toContain('### Card 2');
  });
});

describe('the answer schema', () => {
  it('refuses anything it did not ask for', () => {
    // Strict throughout: a schema that tolerates extra keys will eventually
    // receive a `state` the board has no branch for.
    expect(RESYNC_SCHEMA.additionalProperties).toBe(false);
    expect(RESYNC_SCHEMA.properties.verdicts.items.additionalProperties).toBe(false);
    expect(RESYNC_SCHEMA.properties.verdicts.items.properties.state.enum).toEqual([
      'done',
      'review',
      'unfinished',
    ]);
  });
});

describe('what the board believes back', () => {
  const known = new Set(['card-1', 'card-2']);

  it('takes a well-formed verdict', () => {
    const verdicts = parseVerdicts(
      {
        verdicts: [
          { cardId: 'card-1', state: 'done', evidence: '  Implemented.  ', commits: ['abc1234'] },
        ],
      },
      known,
    );

    expect(verdicts).toEqual([
      { cardId: 'card-1', state: 'done', evidence: 'Implemented.', commits: ['abc1234'] },
    ]);
  });

  it('drops a verdict about a card nobody asked about', () => {
    const verdicts = parseVerdicts(
      { verdicts: [{ cardId: 'card-99', state: 'done', evidence: 'Yes.', commits: [] }] },
      known,
    );

    // An id the model invented arrives looking exactly like this, and this
    // output moves cards into Done.
    expect(verdicts).toEqual([]);
  });

  it('drops a state it has no branch for', () => {
    const verdicts = parseVerdicts(
      { verdicts: [{ cardId: 'card-1', state: 'probably', evidence: 'Yes.', commits: [] }] },
      known,
    );

    expect(verdicts).toEqual([]);
  });

  it('drops a verdict with no reasoning behind it', () => {
    const verdicts = parseVerdicts(
      { verdicts: [{ cardId: 'card-1', state: 'done', evidence: '   ', commits: [] }] },
      known,
    );

    // The evidence is what the operator reads to decide whether to trust the
    // move. A verdict without it is a move with nothing to check.
    expect(verdicts).toEqual([]);
  });

  it('keeps only the first verdict when a card is judged twice', () => {
    const verdicts = parseVerdicts(
      {
        verdicts: [
          { cardId: 'card-1', state: 'unfinished', evidence: 'No trace.', commits: [] },
          { cardId: 'card-1', state: 'done', evidence: 'Actually yes.', commits: [] },
        ],
      },
      known,
    );

    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]?.state).toBe('unfinished');
  });

  it('survives a shape it was not expecting at all', () => {
    expect(parseVerdicts(null, known)).toEqual([]);
    expect(parseVerdicts({ verdicts: 'none' }, known)).toEqual([]);
    expect(parseVerdicts({ verdicts: [null, 3, 'x'] }, known)).toEqual([]);
    expect(parseVerdicts({}, known)).toEqual([]);
  });

  it('keeps a verdict whose commits are missing or malformed', () => {
    const verdicts = parseVerdicts(
      {
        verdicts: [
          { cardId: 'card-1', state: 'done', evidence: 'Implemented.', commits: [1, 'abc', null] },
          { cardId: 'card-2', state: 'review', evidence: 'Partial.' },
        ],
      },
      known,
    );

    // Commit hashes are a nicety beside the evidence sentence, so a bad one
    // costs the citation and not the verdict.
    expect(verdicts[0]?.commits).toEqual(['abc']);
    expect(verdicts[1]?.commits).toEqual([]);
  });
});

describe('what the sweep cost', () => {
  const events = [
    '{"type":"thread.started"}',
    '{"type":"item.completed","item":{"type":"command_execution"}}',
    '{"type":"turn.completed","usage":{"input_tokens":87764,"cached_input_tokens":60160,"output_tokens":757,"reasoning_output_tokens":85}}',
  ].join('\n');

  it('reads the totals off the last event', () => {
    // Cached input is counted: reading a repository is mostly cache hits, and
    // billing only the uncached half would report a sweep at a fifth of what
    // it cost. `input_tokens` is already the whole of it.
    expect(parseUsage(events)).toEqual({ inputTokens: 87_764, outputTokens: 757 });
  });

  it('says nothing rather than zero when there is no such event', () => {
    expect(parseUsage('{"type":"thread.started"}')).toBeNull();
    expect(parseUsage('')).toBeNull();
  });

  it('steps over a line that is not JSON at all', () => {
    // The CLI writes warnings to this stream too, and one of them should not
    // cost the usage figure.
    expect(parseUsage(`warning: something\n${events}`)).toEqual({
      inputTokens: 87_764,
      outputTokens: 757,
    });
  });
});

describe('which model answers', () => {
  it('uses the cheap default when nothing says otherwise', () => {
    expect(resolveResyncModel({})).toBe(DEFAULT_RESYNC_MODEL);
    expect(resolveResyncModel({ GORILLA_RESYNC_MODEL: '   ' })).toBe(DEFAULT_RESYNC_MODEL);
  });

  it('takes the one the operator named', () => {
    // The cheapest model available is a fact about an account, not about this
    // repository, so it has to be settable without editing the source.
    expect(resolveResyncModel({ GORILLA_RESYNC_MODEL: 'gpt-5.4-mini' })).toBe('gpt-5.4-mini');
  });
});
