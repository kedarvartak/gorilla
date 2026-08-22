import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  describeDrained,
  describeHalt,
  drainedEnvironment,
  haltEnvironment,
  notifyDrained,
  notifyHalt,
  NOTIFY_ENV,
} from '../src/server/notify/notify.js';
import type { HaltState } from '../src/server/dispatch/dispatcher.js';

/**
 * Telling the operator the queue stopped (doc 08, P4).
 *
 * A halt nobody hears about at 2am is indistinguishable from a queue that ran
 * all night, so the assertions are about the notification actually leaving -
 * and about it never being able to take the queue down with it.
 */

const HALT: HaltState = {
  reason: 'unacknowledged-surprises',
  cardId: 'card-1',
  cardTitle: 'Wire the ingest path',
  detail: 'two changed files nobody has judged',
  at: Date.UTC(2026, 7, 20, 2, 14, 0),
};

let dir: string;

/**
 * Waits for the detached child to have written its file.
 *
 * Waits for content rather than for existence: the shell creates the redirect
 * target before the command it redirects has run, so a check for the file alone
 * reads an empty one and the test fails for a reason that is not the feature.
 */
async function settle(): Promise<string> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const text = existsSync(join(dir, 'fired')) ? readFileSync(join(dir, 'fired'), 'utf8') : '';
    if (text.trim() !== '') return text;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return '';
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gorilla-notify-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('running the operator’s command', () => {
  it('runs it when one is configured', async () => {
    const started = notifyHalt({
      halt: HALT,
      boardName: 'kanban',
      command: `printenv GORILLA_HALT_MESSAGE > ${join(dir, 'fired')}`,
    });

    expect(started).toBe(true);
    expect(await settle()).toContain('Wire the ingest path');
  });

  it('does nothing when none is configured', () => {
    expect(notifyHalt({ halt: HALT, boardName: 'kanban', command: undefined })).toBe(false);
    expect(notifyHalt({ halt: HALT, boardName: 'kanban', command: '   ' })).toBe(false);
  });

  it('passes a title a shell would have mangled', async () => {
    // A card title is free text an agent wrote. Interpolated into a command
    // string this breaks on the first quote and does something far worse on
    // the first $(...), which is why nothing is interpolated at all.
    const hostile = { ...HALT, cardTitle: 'Fix "quotes" and $(touch pwned)' };

    notifyHalt({
      halt: hostile,
      boardName: 'kanban',
      command: `printenv GORILLA_HALT_CARD > ${join(dir, 'fired')}`,
      cwd: dir,
    });

    expect(await settle()).toContain('$(touch pwned)');
    expect(existsSync(join(dir, 'pwned'))).toBe(false);
  });

  it('survives a command that cannot run', () => {
    const errors: unknown[] = [];

    // A typo'd notifier must not become a second reason the queue is stuck.
    expect(() =>
      notifyHalt({
        halt: HALT,
        boardName: 'kanban',
        command: 'definitely-not-a-real-binary-9182',
        onError: (error) => errors.push(error),
      }),
    ).not.toThrow();
  });
});

describe('what the command is told', () => {
  it('carries the reason, the card and the detail', () => {
    const env = haltEnvironment(HALT, 'kanban');

    expect(env['GORILLA_HALT_REASON']).toBe('unacknowledged-surprises');
    expect(env['GORILLA_HALT_CARD_ID']).toBe('card-1');
    expect(env['GORILLA_HALT_DETAIL']).toBe('two changed files nobody has judged');
    expect(env['GORILLA_BOARD']).toBe('kanban');
  });

  it('states when it happened, in a form that does not depend on the reader', () => {
    // The operator reads this in the morning; a relative time would be a lie
    // by then and a local-format one would depend on where the reader is.
    expect(haltEnvironment(HALT, 'kanban')['GORILLA_HALT_AT']).toBe('2026-08-20T02:14:00.000Z');
  });

  it('offers a ready-made single line', () => {
    // Most notifiers want one message argument and should not have to build it.
    expect(describeHalt(HALT, 'kanban')).toBe(
      'Gorilla (kanban) halted on "Wire the ingest path": two changed files nobody has judged',
    );
  });

  it('names the environment variable the board reads', () => {
    expect(NOTIFY_ENV).toBe('GORILLA_NOTIFY');
  });
});

describe('being told the queue is empty', () => {
  it('carries the counts and a one-line message', () => {
    const environment = drainedEnvironment({
      boardName: 'kanban',
      completed: 7,
      blocked: 2,
      at: 1_700_000_000_000,
    });

    expect(environment['GORILLA_DRAINED_COMPLETED']).toBe('7');
    expect(environment['GORILLA_DRAINED_BLOCKED']).toBe('2');
    expect(environment['GORILLA_MESSAGE']).toContain('7 card(s) finished');
  });

  it('says which of the two events it was', () => {
    // A command that only cares about failures should be able to look at one
    // variable rather than infer from which others are present.
    expect(
      drainedEnvironment({ boardName: 'b', completed: 1, blocked: 0, at: 1 })['GORILLA_EVENT'],
    ).toBe('drained');
    expect(haltEnvironment(HALT, 'b')['GORILLA_EVENT']).toBe('halt');
  });

  it('does not mention blocked cards when there are none', () => {
    expect(describeDrained({ boardName: 'b', completed: 3, blocked: 0, at: 1 })).not.toContain(
      'blocked',
    );
  });

  it('does nothing when no command is configured', () => {
    expect(
      notifyDrained({
        drained: { boardName: 'b', completed: 1, blocked: 0, at: 1 },
        command: undefined,
      }),
    ).toBe(false);
  });

  it('keeps a board name out of the command line', () => {
    // Same discipline as the halt: a board name is free text, and a shell that
    // sees it is a shell that can be made to do something else.
    const environment = drainedEnvironment({
      boardName: '"; rm -rf / #',
      completed: 1,
      blocked: 0,
      at: 1,
    });

    expect(environment['GORILLA_BOARD']).toBe('"; rm -rf / #');
  });
});
