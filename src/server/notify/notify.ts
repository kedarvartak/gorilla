import { spawn } from 'node:child_process';

import type { HaltState } from '../dispatch/dispatcher.js';

/**
 * Telling the operator the queue stopped (doc 08, P4).
 *
 * The gate is the point of the queue: a card that finished is not a card that
 * was read, so the board stops rather than building the next thing on an
 * unreviewed one. But a stop nobody hears about at 2am is indistinguishable
 * from a queue that ran all night, and the operator finds out at breakfast
 * having lost six hours of unattended work.
 *
 * So a halt can run a command of the operator's choosing - `notify-send`,
 * `terminal-notifier`, a curl to a webhook. Configured through the environment
 * like `GORILLA_EXTRACTION` and `GORILLA_DB_PATH` rather than through the
 * database, because a notification for an overnight halt is worthless if it
 * does not survive the board being restarted.
 *
 * Two rules hold this to the fail-open discipline the hook path already keeps:
 * the halt never waits for the notifier, and the notifier failing never
 * unhalts, un-publishes or otherwise touches the queue.
 */

/** The command to run when a board's queue halts. Empty means no notification. */
export const NOTIFY_ENV = 'GORILLA_NOTIFY';

/** Killed after this. A hung notifier must not accumulate processes overnight. */
export const NOTIFY_TIMEOUT_MS = 10_000;

export interface NotifyInput {
  readonly halt: HaltState;
  readonly boardName: string;
  readonly command?: string | undefined;
  readonly cwd?: string | undefined;
  readonly onError?: ((error: unknown) => void) | undefined;
}

/**
 * The facts about the halt, as environment variables.
 *
 * Never interpolated into the command string. A card title is free text an
 * agent wrote, and pasting it into a shell command would break on the first
 * quote and do something worse on the first `$(...)`. Through the environment
 * the quoting problem does not exist.
 */
export function haltEnvironment(halt: HaltState, boardName: string): Record<string, string> {
  return {
    GORILLA_BOARD: boardName,
    GORILLA_HALT_REASON: halt.reason,
    GORILLA_HALT_CARD: halt.cardTitle,
    GORILLA_HALT_CARD_ID: halt.cardId,
    GORILLA_HALT_DETAIL: halt.detail,
    GORILLA_HALT_AT: new Date(halt.at).toISOString(),
    // A one-line version, for the common case of a command that wants a single
    // message argument and should not have to assemble one.
    GORILLA_HALT_MESSAGE: describeHalt(halt, boardName),
  };
}

export function describeHalt(halt: HaltState, boardName: string): string {
  return `Gorilla (${boardName}) halted on "${halt.cardTitle}": ${halt.detail}`;
}

/**
 * Runs the notify command, if one is configured.
 *
 * Returns whether anything was started, so `doctor` can report an unconfigured
 * board rather than leaving the operator to wonder why the night was quiet.
 * Never throws and never awaits the child.
 */
export function notifyHalt(input: NotifyInput): boolean {
  const command = (input.command ?? '').trim();
  if (command === '') return false;

  try {
    const child = spawn(command, {
      shell: true,
      cwd: input.cwd,
      env: { ...process.env, ...haltEnvironment(input.halt, input.boardName) },
      // Detached and ignored: the board is not the notifier's parent in any
      // useful sense, and inheriting stdio would interleave a desktop tool's
      // chatter with the server log.
      stdio: 'ignore',
      detached: true,
      timeout: NOTIFY_TIMEOUT_MS,
    });

    // A notifier that cannot even be spawned - a typo'd binary - is reported
    // and then dropped. It must not become a second reason the queue is stuck.
    child.on('error', (error) => input.onError?.(error));
    child.unref();
    return true;
  } catch (error) {
    input.onError?.(error);
    return false;
  }
}
