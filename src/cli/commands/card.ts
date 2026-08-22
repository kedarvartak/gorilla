import { DEFAULT_HOST, DEFAULT_PORT } from '../../server/index.js';
import type { Command, CommandResult } from '../cli.js';

/**
 * Driving one card from a shell (T56, T57).
 *
 * These talk to the running board rather than doing the work themselves, and
 * that is the design rather than a shortcut. Dispatch belongs to the process
 * that owns the worktrees and supervises the launcher: a second process
 * starting a run would spawn an agent that dies when the command exits, and
 * would race the server for the same checkout. The card lease added in T7
 * would refuse it, correctly, and the operator would be left with a command
 * that cannot work.
 *
 * So the command is a client. It says so when nothing is listening, because
 * "no board is running" is the answer, not an error to hide.
 */

const TIMEOUT_MS = 10_000;

interface Options {
  readonly url: string;
  readonly json: boolean;
  readonly cardId: string | undefined;
}

function parse(args: readonly string[]): Options {
  const portIndex = args.indexOf('--port');
  const port = portIndex === -1 ? DEFAULT_PORT : Number(args[portIndex + 1]);

  return {
    url: `http://${DEFAULT_HOST}:${String(port)}`,
    json: args.includes('--json'),
    // The first argument that is not a flag or a flag's value.
    cardId: args.find(
      (value, index) =>
        !value.startsWith('--') && (index === 0 || !args[index - 1]?.startsWith('--')),
    ),
  };
}

async function boardIdFor(url: string, cardId: string): Promise<string | null> {
  const response = await fetch(`${url}/api/cards/${cardId}`, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) return null;

  const body = (await response.json()) as { boardId?: string };
  return body.boardId ?? null;
}

async function post(url: string): Promise<{ status: number; body: unknown }> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  return { status: response.status, body: await response.json().catch(() => ({})) };
}

async function run(args: readonly string[], what: 'dispatch' | 'verify'): Promise<CommandResult> {
  const options = parse(args);

  if (options.cardId === undefined) {
    return { exitCode: 1, stdout: '', stderr: `Name the card: gorilla ${what} <card-id>` };
  }

  try {
    const boardId = await boardIdFor(options.url, options.cardId);
    if (boardId === null) {
      return { exitCode: 1, stdout: '', stderr: `No such card: ${options.cardId}` };
    }

    const { status, body } = await post(
      `${options.url}/api/boards/${boardId}/cards/${options.cardId}/${what}`,
    );

    if (options.json) {
      return { exitCode: status < 400 ? 0 : 1, stdout: JSON.stringify(body, null, 2), stderr: '' };
    }

    const note = (body as { note?: string; error?: string }).note ?? '';
    if (status >= 400) {
      return {
        exitCode: 1,
        stdout: '',
        stderr: (body as { error?: string }).error ?? `Refused with ${String(status)}.`,
      };
    }

    // A verify that did not run is reported as not having run. Saying nothing
    // would read as a pass, which is the one thing it must not read as.
    return { exitCode: 0, stdout: note === '' ? `${what} accepted.` : note, stderr: '' };
  } catch {
    return {
      exitCode: 1,
      stdout: '',
      stderr: `No board is serving on ${options.url}. Dispatch belongs to the running board, not to this command.`,
    };
  }
}

export const dispatchCommand: Command = {
  name: 'dispatch',
  summary: 'Ask the running board to dispatch a card',
  run: (args) => run(args, 'dispatch'),
};

export const verifyCommand: Command = {
  name: 'verify',
  summary: "Run a card's verify command in its worktree",
  run: (args) => run(args, 'verify'),
};
