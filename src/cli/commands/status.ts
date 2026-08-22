import { existsSync } from 'node:fs';

import { openDatabase, resolveDatabasePath } from '../../server/db/client.js';
import { DEFAULT_HOST, DEFAULT_PORT } from '../../server/index.js';
import type { Health } from '../../server/health.js';
import type { Command, CommandResult } from '../cli.js';

/**
 * What the board is doing, without opening the interface (T55, T58).
 *
 * An unattended board is one nobody is watching, which makes "is it still
 * going" a question that has to be answerable from a shell - by a person at
 * breakfast, or by whatever they wired `GORILLA_NOTIFY` to.
 *
 * Two sources, and the difference between them is the answer to the most
 * important question. A running server knows what is in flight. The database
 * alone knows only what was last written down, and if that is all there is,
 * then nothing is dispatching anything - which is worth saying in those words
 * rather than reporting an empty queue and letting the operator infer calm.
 */

const TIMEOUT_MS = 2_000;

interface Offline {
  readonly boards: { name: string; queued: number; running: number; blocked: number }[];
}

async function fromServer(url: string): Promise<Health | null> {
  try {
    const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!response.ok) return null;
    return (await response.json()) as Health;
  } catch {
    // Nothing listening, or something that is not a board. Either way there is
    // no live answer, which the caller reports rather than papers over.
    return null;
  }
}

function fromDatabase(databasePath: string): Offline | null {
  // A database that is not there is not an error. It is a directory where
  // nobody has run `gorilla serve` yet, and saying "no such table: boards" to
  // that operator tells them about SQLite instead of about their board.
  if (!existsSync(databasePath)) return null;

  const handle = openDatabase({ path: databasePath, migrate: false });

  try {
    const boards = handle.sqlite.prepare('SELECT id, name FROM boards').all() as {
      id: string;
      name: string;
    }[];

    return {
      boards: boards.map((board) => {
        const counts = handle.sqlite
          .prepare(
            `SELECT
               SUM(CASE WHEN status = 'idle' THEN 1 ELSE 0 END) AS queued,
               SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running,
               SUM(CASE WHEN status = 'blocked' THEN 1 ELSE 0 END) AS blocked
             FROM cards WHERE board_id = ?`,
          )
          .get(board.id) as {
          queued: number | null;
          running: number | null;
          blocked: number | null;
        };

        return {
          name: board.name,
          queued: counts.queued ?? 0,
          // Stale by definition: with no server there is nothing supervising
          // these, and startup will move them out of running. Reported as it
          // is stored, and labelled, rather than silently corrected here.
          running: counts.running ?? 0,
          blocked: counts.blocked ?? 0,
        };
      }),
    };
  } finally {
    handle.close();
  }
}

function renderLive(health: Health): string {
  const lines = [`status: ${health.status}`];

  for (const board of health.boards) {
    lines.push(
      `${board.name}: ${String(board.queued)} queued, ${String(board.running)} running, ${String(board.blocked)} blocked`,
    );
    if (board.halted !== null) {
      lines.push(`  halted: ${board.halted.reason} on "${board.halted.cardTitle}"`);
    }
  }

  if (health.lastEventAt === null) {
    // Not "quiet". No event has ever arrived, which usually means the hooks
    // point at a different port - a fixable configuration problem, and a very
    // different thing from a board with nothing to do.
    lines.push('No hook event has ever arrived. Run `gorilla doctor`.');
  } else {
    const minutes = Math.round((Date.now() - health.lastEventAt) / 60_000);
    lines.push(`last event: ${String(minutes)} minute(s) ago`);
  }

  if (health.build.note !== null) lines.push(health.build.note);

  return lines.join('\n');
}

function renderOffline(offline: Offline, url: string): string {
  const lines = [
    `No board is serving on ${url}, so nothing is dispatching anything.`,
    'What follows is the last state written to the database.',
    '',
  ];

  for (const board of offline.boards) {
    lines.push(
      `${board.name}: ${String(board.queued)} queued, ${String(board.blocked)} blocked` +
        (board.running === 0
          ? ''
          : `, ${String(board.running)} marked running (cut off - the next start will move them)`),
    );
  }

  return lines.join('\n');
}

export const statusCommand: Command = {
  name: 'status',
  summary: 'What the board is doing, from the shell',
  async run(args: readonly string[]): Promise<CommandResult> {
    const json = args.includes('--json');
    const portIndex = args.indexOf('--port');
    const dbIndex = args.indexOf('--db');

    const port = portIndex === -1 ? DEFAULT_PORT : Number(args[portIndex + 1]);
    const url = `http://${DEFAULT_HOST}:${String(port)}`;

    try {
      const health = await fromServer(url);
      if (health !== null) {
        return {
          exitCode: 0,
          stdout: json ? JSON.stringify({ serving: true, ...health }, null, 2) : renderLive(health),
          stderr: '',
        };
      }

      const databasePath = resolveDatabasePath(dbIndex === -1 ? undefined : args[dbIndex + 1]);
      const offline = fromDatabase(databasePath);

      if (offline === null) {
        return {
          exitCode: 1,
          stdout: json
            ? JSON.stringify({ serving: false, url, boards: null, database: databasePath }, null, 2)
            : `No board is serving on ${url}, and there is no board database at ${databasePath}. Run \`gorilla serve\`.`,
          stderr: '',
        };
      }

      // Exit 1, because "no board is running" is the failure a script watching
      // this command exists to notice. A zero here would let a cron job report
      // a healthy night to an operator whose board died at midnight.
      return {
        exitCode: 1,
        stdout: json
          ? JSON.stringify({ serving: false, url, ...offline }, null, 2)
          : renderOffline(offline, url),
        stderr: '',
      };
    } catch (error) {
      return { exitCode: 1, stdout: '', stderr: (error as Error).message };
    }
  },
};
