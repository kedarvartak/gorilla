import { existsSync, readFileSync } from 'node:fs';

import { describePlan, parseCardList } from '../../server/cards/intake.js';
import { DEFAULT_HOST, DEFAULT_PORT } from '../../server/index.js';
import type { Command, CommandResult } from '../cli.js';

/**
 * Adding a written list of tasks to the board (T51).
 *
 * Through the running board rather than straight into the database. A card
 * written behind the server's back never publishes on the stream, so an open
 * board would not show it until somebody reloaded - which reads as the command
 * having failed.
 */

const TIMEOUT_MS = 10_000;

interface Board {
  readonly id: string;
  readonly name: string;
}

async function firstBoard(url: string): Promise<Board | null> {
  const response = await fetch(`${url}/api/boards`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!response.ok) return null;

  const boards = (await response.json()) as Board[];
  return boards[0] ?? null;
}

export const addCommand: Command = {
  name: 'add',
  summary: 'Add a markdown list of tasks to the board as cards',
  async run(args: readonly string[]): Promise<CommandResult> {
    const fileIndex = args.indexOf('--file');
    const portIndex = args.indexOf('--port');
    const boardIndex = args.indexOf('--board');

    const file = fileIndex === -1 ? undefined : args[fileIndex + 1];
    if (file === undefined) {
      return { exitCode: 1, stdout: '', stderr: 'Name the file: gorilla add --file plan.md' };
    }
    if (!existsSync(file)) {
      return { exitCode: 1, stdout: '', stderr: `There is no file at ${file}.` };
    }

    const parsed = parseCardList(readFileSync(file, 'utf8'));

    // The dry run reads the file and talks to nothing. An operator checking
    // what a command will do should not have to have a board running to find
    // out, and should not risk half of it happening.
    if (args.includes('--dry-run')) {
      return { exitCode: 0, stdout: describePlan(parsed).join('\n'), stderr: '' };
    }

    if (parsed.cards.length === 0) {
      return { exitCode: 1, stdout: describePlan(parsed).join('\n'), stderr: '' };
    }

    const port = portIndex === -1 ? DEFAULT_PORT : Number(args[portIndex + 1]);
    const url = `http://${DEFAULT_HOST}:${String(port)}`;

    try {
      const requested = boardIndex === -1 ? undefined : args[boardIndex + 1];
      const board =
        requested === undefined ? await firstBoard(url) : { id: requested, name: requested };

      if (board === null) {
        return { exitCode: 1, stdout: '', stderr: 'That board has no boards to add to.' };
      }

      const added: string[] = [];
      const refused: string[] = [];

      for (const card of parsed.cards) {
        const response = await fetch(`${url}/api/boards/${board.id}/cards`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ title: card.title, body: card.body }),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });

        if (!response.ok) {
          refused.push(`${card.title}: ${String(response.status)}`);
          continue;
        }

        // The duplicate warning travels with the card, because the board
        // decided to add it anyway and the operator should know it did.
        const body = (await response.json()) as { duplicateNote?: string | null };
        added.push(
          body.duplicateNote === undefined || body.duplicateNote === null
            ? card.title
            : `${card.title} - ${body.duplicateNote}`,
        );
      }

      const lines = added.map((title) => `added: ${title}`);
      for (const problem of refused) lines.push(`refused: ${problem}`);

      // Partial success is reported as partial. A command that added seven of
      // ten and exited zero would have the operator believe all ten are there.
      return {
        exitCode: refused.length === 0 ? 0 : 1,
        stdout: lines.join('\n'),
        stderr: '',
      };
    } catch {
      return {
        exitCode: 1,
        stdout: '',
        stderr: `No board is serving on ${url}. Cards go through the board so an open interface sees them arrive.`,
      };
    }
  },
};
