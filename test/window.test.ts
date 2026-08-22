import { describe, expect, it } from 'vitest';

import { describeWindow, isOpen, isValidHour, msUntilOpen } from '../src/server/dispatch/window.js';

/**
 * When a board is allowed to start work (T41).
 *
 * "Define tasks, run them, go to sleep" has an unstated bound: the operator
 * wants the night, not the working day. A queue still dispatching at 09:30 is
 * competing with them for the checkout, the test runner and the rate limit.
 */

function at(hour: number): Date {
  const date = new Date(2026, 7, 22, hour, 30, 0, 0);
  return date;
}

describe('an ordinary window', () => {
  const window = { fromHour: 9, toHour: 17 };

  it('is open inside it', () => {
    expect(isOpen(window, at(9))).toBe(true);
    expect(isOpen(window, at(16))).toBe(true);
  });

  it('is shut outside it', () => {
    expect(isOpen(window, at(8))).toBe(false);
    expect(isOpen(window, at(17))).toBe(false);
  });
});

describe('a window across midnight', () => {
  const overnight = { fromHour: 22, toHour: 7 };

  it('is the normal case, not an edge case', () => {
    // 22 to 07 is what "overnight" means, which is the whole point of this.
    expect(isOpen(overnight, at(23))).toBe(true);
    expect(isOpen(overnight, at(2))).toBe(true);
  });

  it('is shut during the day', () => {
    expect(isOpen(overnight, at(12))).toBe(false);
    expect(isOpen(overnight, at(7))).toBe(false);
  });
});

describe('a window with the same hour twice', () => {
  it('is always open', () => {
    // A board configured 9 to 9 that silently never ran again would be
    // indistinguishable from a broken queue.
    expect(isOpen({ fromHour: 9, toHour: 9 }, at(3))).toBe(true);
  });
});

describe('waking up', () => {
  it('is immediate when the window is already open', () => {
    expect(msUntilOpen({ fromHour: 9, toHour: 17 }, at(10))).toBe(0);
  });

  it('waits for today’s opening when it has not passed', () => {
    // 08:30 to 09:00 is half an hour.
    expect(msUntilOpen({ fromHour: 9, toHour: 17 }, at(8))).toBe(30 * 60_000);
  });

  it('waits for tomorrow when today’s has passed', () => {
    // 18:30 to 09:00 tomorrow.
    expect(msUntilOpen({ fromHour: 9, toHour: 17 }, at(18))).toBe(14.5 * 60 * 60_000);
  });
});

describe('saying it', () => {
  it('names when the queue will start again', () => {
    // A hold nobody can predict the end of reads as a stuck board.
    expect(describeWindow({ fromHour: 22, toHour: 7 }, at(12))).toContain('until 22:00');
  });

  it('says it is dispatching when it is', () => {
    expect(describeWindow({ fromHour: 22, toHour: 7 }, at(23))).toContain('which is now');
  });
});

describe('validating an hour', () => {
  it('accepts the day', () => {
    expect(isValidHour(0)).toBe(true);
    expect(isValidHour(23)).toBe(true);
  });

  it('refuses anything else', () => {
    expect(isValidHour(24)).toBe(false);
    expect(isValidHour(-1)).toBe(false);
    expect(isValidHour(9.5)).toBe(false);
    expect(isValidHour('9')).toBe(false);
  });
});
