import { existsSync, writeFileSync } from 'node:fs';

import { renderBoardExport } from '../../server/board-export.js';
import { schemaTooOld } from './read-only.js';
import { openDatabase, resolveDatabasePath } from '../../server/db/client.js';
import type { Command, CommandResult } from '../cli.js';

/**
 * The whole board as one file (T54).
 *
 * Read from the database rather than from a running server, because one of the
 * times this is most wanted is when nothing is serving.
 */
export const exportCommand: Command = {
  name: 'export',
  summary: 'Write the whole board out as markdown',
  run(args: readonly string[]): Promise<CommandResult> {
    const dbIndex = args.indexOf('--db');
    const outIndex = args.indexOf('--out');
    const boardIndex = args.indexOf('--board');

    const databasePath = resolveDatabasePath(dbIndex === -1 ? undefined : args[dbIndex + 1]);

    if (!existsSync(databasePath)) {
      return Promise.resolve({
        exitCode: 1,
        stdout: '',
        stderr: `There is no board database at ${databasePath}.`,
      });
    }

    const handle = openDatabase({ path: databasePath, migrate: false });

    try {
      const boards = handle.sqlite
        .prepare('SELECT id, name FROM boards ORDER BY created_at')
        .all() as {
        id: string;
        name: string;
      }[];

      const requested = boardIndex === -1 ? undefined : args[boardIndex + 1];
      const board =
        requested === undefined ? boards[0] : boards.find((row) => row.id === requested);

      if (board === undefined) {
        // Lists them rather than only refusing. An operator who does not know
        // the id is exactly the operator who needs this command.
        const known = boards.map((row) => `  ${row.id}  ${row.name}`).join('\n');
        return Promise.resolve({
          exitCode: 1,
          stdout: '',
          stderr:
            boards.length === 0
              ? 'That database holds no boards.'
              : `No such board. This database holds:\n${known}`,
        });
      }

      let rendered: string | null;
      try {
        rendered = renderBoardExport(handle.sqlite, board.id, Date.now());
      } catch (error) {
        // A database written by an older build is missing columns this one
        // reads. Crashing tells the operator about SQLite; this tells them
        // what to do.
        const note = schemaTooOld(error);
        if (note === null) throw error;
        return Promise.resolve({ exitCode: 1, stdout: '', stderr: note });
      }

      if (rendered === null) {
        return Promise.resolve({
          exitCode: 1,
          stdout: '',
          stderr: 'That board could not be read.',
        });
      }

      const out = outIndex === -1 ? undefined : args[outIndex + 1];
      if (out !== undefined) {
        writeFileSync(out, rendered, 'utf8');
        return Promise.resolve({ exitCode: 0, stdout: `Wrote ${out}`, stderr: '' });
      }

      return Promise.resolve({ exitCode: 0, stdout: rendered, stderr: '' });
    } finally {
      handle.close();
    }
  },
};
