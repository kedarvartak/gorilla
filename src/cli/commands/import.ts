import { cardFor, fetchIssues, TOKEN_ENV } from '../../server/cards/github.js';
import { DEFAULT_HOST, DEFAULT_PORT } from '../../server/index.js';
import type { Command, CommandResult } from '../cli.js';

/**
 * Putting GitHub issues on the board (T50).
 *
 * On demand, never on a timer. A board that polled an issue tracker would
 * eventually reopen a card the operator deleted on purpose, and they would
 * have to fight it.
 *
 * Through the running board, like `add`, so an open interface sees the cards
 * arrive rather than finding them on the next reload.
 */

function flag(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

export const importCommand: Command = {
  name: 'import',
  summary: 'Put a GitHub repository’s open issues on the board as cards',
  async run(args: readonly string[]): Promise<CommandResult> {
    const repo = flag(args, '--repo');
    if (repo === undefined) {
      return {
        exitCode: 1,
        stdout: '',
        stderr: 'usage: gorilla import --repo owner/name [--label bug] [--state open] [--dry-run]',
      };
    }

    const token = (process.env[TOKEN_ENV] ?? '').trim();
    if (token === '') {
      return {
        exitCode: 1,
        stdout: '',
        stderr: `${TOKEN_ENV} is not set. It needs read access to that repository's issues; see .env.example.`,
      };
    }

    const state = flag(args, '--state');
    const label = flag(args, '--label');

    const result = await fetchIssues({
      repo,
      token,
      ...(state === 'open' || state === 'closed' || state === 'all' ? { state } : {}),
      ...(label === undefined ? {} : { label }),
    });

    if (!result.ok) return { exitCode: 1, stdout: '', stderr: result.why };

    if (result.issues.length === 0) {
      // Said rather than exiting quietly. Nothing matching and something going
      // wrong look identical when a command prints nothing.
      return { exitCode: 0, stdout: `No issues match in ${repo}.`, stderr: '' };
    }

    const cards = result.issues.map(cardFor);

    if (args.includes('--dry-run')) {
      return {
        exitCode: 0,
        stdout: cards.map((card) => card.title).join('\n'),
        stderr: '',
      };
    }

    const portArg = flag(args, '--port');
    const port = portArg === undefined ? DEFAULT_PORT : Number(portArg);
    const url = `http://${DEFAULT_HOST}:${String(port)}`;

    try {
      const boardsResponse = await fetch(`${url}/api/boards`, {
        signal: AbortSignal.timeout(10_000),
      });
      const boards = (await boardsResponse.json()) as { id: string }[];
      const boardId = flag(args, '--board') ?? boards[0]?.id;

      if (boardId === undefined) {
        return { exitCode: 1, stdout: '', stderr: 'That board has no boards to import into.' };
      }

      const added: string[] = [];
      const refused: string[] = [];

      for (const card of cards) {
        const response = await fetch(`${url}/api/boards/${boardId}/cards`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(card),
          signal: AbortSignal.timeout(10_000),
        });

        if (response.ok) added.push(card.title);
        else refused.push(`${card.title}: ${String(response.status)}`);
      }

      const lines = added.map((title) => `added: ${title}`);
      for (const problem of refused) lines.push(`refused: ${problem}`);

      // Duplicate detection is the board's job and it already runs on create,
      // so re-importing a repository warns per card rather than silently
      // doubling the board.
      return { exitCode: refused.length === 0 ? 0 : 1, stdout: lines.join('\n'), stderr: '' };
    } catch {
      return {
        exitCode: 1,
        stdout: '',
        stderr: `No board is serving on ${url}. Cards go through the board so an open interface sees them arrive.`,
      };
    }
  },
};
