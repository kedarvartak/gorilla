import { existsSync, writeFileSync } from 'node:fs';

import { openDatabase, resolveDatabasePath } from '../../server/db/client.js';
import { fixtureFromRun, renderFixture } from '../../server/fixtures/from-run.js';
import type { Command, CommandResult } from '../cli.js';
import { schemaTooOld } from './read-only.js';

/**
 * Making a replayable fixture out of a run that already happened (T66).
 *
 * The recorder only captures what it was running for. This reads a run back
 * out of the database, so a dispatch bug found afterwards can be reproduced
 * rather than described.
 */
export const fixtureCommand: Command = {
  name: 'fixture',
  summary: 'Write a recorded run out as a replayable fixture',
  run(args: readonly string[]): Promise<CommandResult> {
    const positional = args.filter(
      (value, index) => !value.startsWith('--') && !args[index - 1]?.startsWith('--'),
    );
    const runId = positional[0];

    if (runId === undefined) {
      return Promise.resolve({
        exitCode: 1,
        stdout: '',
        stderr: 'usage: gorilla fixture <run-id> [--out fixture.jsonl] [--db path]',
      });
    }

    const dbIndex = args.indexOf('--db');
    const outIndex = args.indexOf('--out');
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
      const fixture = fixtureFromRun(handle.sqlite, runId);

      if (fixture.count === 0) {
        // Said rather than writing an empty file. A zero-byte fixture replays
        // silently and looks like a run that did nothing.
        return Promise.resolve({
          exitCode: 1,
          stdout: '',
          stderr: `No events are recorded for run ${runId}.`,
        });
      }

      const rendered = renderFixture(fixture);
      const out = outIndex === -1 ? undefined : args[outIndex + 1];

      if (out !== undefined) {
        writeFileSync(out, rendered, 'utf8');
        return Promise.resolve({
          exitCode: 0,
          stdout: [
            `Wrote ${String(fixture.count)} event(s) to ${out}.`,
            `Replay it with \`gorilla replay ${out}\`.`,
            // Said every time. Credentials are redacted, but a fixture is a
            // recording of what a run read, and what a run reads is source
            // code. This is a file people commit.
            'It carries the file contents and diffs that run saw. Read it before committing it.',
          ].join('\n'),
          stderr: '',
        });
      }

      return Promise.resolve({ exitCode: 0, stdout: rendered, stderr: '' });
    } catch (error) {
      const note = schemaTooOld(error);
      if (note === null) throw error;
      return Promise.resolve({ exitCode: 1, stdout: '', stderr: note });
    } finally {
      handle.close();
    }
  },
};
