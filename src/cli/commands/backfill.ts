import { eq } from 'drizzle-orm';

import { openDatabase } from '../../server/db/client.js';
import { boards } from '../../server/db/schema.js';
import { canonicaliseCwd } from '../../server/ingest/binding.js';
import { ensureBoardForCwd } from '../../server/start.js';
import { backfillFromTranscripts, describeBackfill } from '../../server/transcript/backfill.js';
import type { Command, CommandResult } from '../cli.js';

/**
 * `gorilla backfill` - recover sessions that ran before the board existed.
 *
 * The adoption path. Installing a comprehension tool on a project with weeks of
 * history and being shown an empty board is the worst possible opening, because
 * the tool's whole claim is that it remembers.
 *
 * Run against the project directory, and safe to run repeatedly: a session the
 * board already knows is skipped rather than duplicated or re-read.
 */
export const backfillCommand: Command = {
  name: 'backfill',
  summary: 'Recover past sessions in this directory from their transcripts',
  async run(args: readonly string[]): Promise<CommandResult> {
    const cwd = process.cwd();
    const database = openDatabase({});

    try {
      const canonical = canonicaliseCwd(cwd);
      const existing = database.db.select().from(boards).where(eq(boards.cwd, canonical)).get();

      // Creating the board here rather than refusing: an operator running
      // backfill in a project is telling us they want a board for it, and
      // making them run two commands to say one thing is friction for its own
      // sake.
      const board = existing ?? ensureBoardForCwd(database, cwd);

      const result = await backfillFromTranscripts({
        handle: database,
        boardId: board.id,
        cwd,
      });

      const lines = [`Board "${board.name}" observing ${canonical}`, ...describeBackfill(result)];

      if (args.includes('--json')) {
        return { exitCode: 0, stdout: JSON.stringify(result, null, 2), stderr: '' };
      }

      return { exitCode: 0, stdout: lines.join('\n'), stderr: '' };
    } finally {
      database.close();
    }
  },
};
