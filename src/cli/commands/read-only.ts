/**
 * Reading a database an older build wrote.
 *
 * The read-only commands open the database without migrating it, deliberately:
 * a command that only reports should not quietly rewrite the operator's
 * schema, and one that did could not be run against a board somebody else's
 * server is using.
 *
 * The cost is that a database from an earlier build is missing columns this
 * build reads. Left alone, that surfaces as an unhandled SQLite error with a
 * stack trace, which tells the operator about better-sqlite3 rather than about
 * their board.
 */

/** The message for a schema this build has outrun, or null for anything else. */
export function schemaTooOld(error: unknown): string | null {
  const message = error instanceof Error ? error.message : String(error);
  if (!/no such (column|table)/i.test(message)) return null;

  return [
    `This board database was written by an older version of Gorilla: ${message}.`,
    'Run `gorilla serve` once to bring it up to date. Nothing here migrates it,',
    'because a command that only reports should not rewrite your schema.',
  ].join('\n');
}
