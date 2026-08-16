import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';

import * as schema from './schema.js';

export type Db = ReturnType<typeof drizzle<typeof schema>>;

export interface DatabaseHandle {
  readonly db: Db;
  readonly sqlite: Database.Database;
  readonly path: string;
  close(): void;
}

export interface OpenDatabaseOptions {
  /** Overrides both the env var and the default location. `:memory:` is valid. */
  readonly path?: string;
  /** Defaults to true. Tests that assert on migration behaviour turn it off. */
  readonly migrate?: boolean;
}

/**
 * Resolution order: explicit option, then GORILLA_DB_PATH, then the default.
 * The env var exists so tests and the fixture harness (T5) never touch the
 * operator's real database.
 */
export function resolveDatabasePath(explicit?: string): string {
  if (explicit !== undefined && explicit !== '') return explicit;

  const fromEnv = process.env['GORILLA_DB_PATH'];
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv;

  return join(homedir(), '.gorilla', 'gorilla.db');
}

/**
 * The migrations folder is SQL, so tsc does not copy it into dist. Try the
 * locations it can legitimately occupy rather than assuming one layout, and
 * fail loudly instead of silently starting on an unmigrated database.
 */
function resolveMigrationsDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, 'migrations'),
    resolve(here, '../../../src/server/db/migrations'),
    resolve(here, '../../../../src/server/db/migrations'),
  ];

  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'meta', '_journal.json'))) return candidate;
  }

  throw new Error(`Could not locate database migrations. Looked in:\n  ${candidates.join('\n  ')}`);
}

export function openDatabase(options: OpenDatabaseOptions = {}): DatabaseHandle {
  const path = resolveDatabasePath(options.path);

  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true });
  }

  const sqlite = new Database(path);

  // WAL keeps the single writer from blocking readers (doc 06). It is a no-op
  // on an in-memory database, which SQLite reports by returning 'memory'.
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');
  // NORMAL is durable across application crashes, only losing the very last
  // transactions on power loss. The event stream can tolerate that; the latency
  // budget on the hook path (doc 06) cannot tolerate a full fsync per insert.
  sqlite.pragma('synchronous = NORMAL');

  const db = drizzle(sqlite, { schema });

  if (options.migrate !== false) {
    migrate(db, { migrationsFolder: resolveMigrationsDir() });
  }

  return {
    db,
    sqlite,
    path,
    close: () => {
      sqlite.close();
    },
  };
}
