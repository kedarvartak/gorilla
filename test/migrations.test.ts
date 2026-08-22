import Database from 'better-sqlite3';
import { readFileSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getTableConfig, type SQLiteTable } from 'drizzle-orm/sqlite-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import * as schema from '../src/server/db/schema.js';

/**
 * The migration ladder (T5) and the drift between it and the schema (T6).
 *
 * There are fourteen migrations now and nothing checked either property. A
 * migration that only applies to a database built by the previous migration -
 * rather than to one built by every migration before it - fails on exactly one
 * machine: the operator's, months later, with their data in it.
 *
 * And a schema that has drifted from the migrations is worse than either,
 * because everything typechecks. The code addresses a column the database does
 * not have, and the failure arrives at runtime as a SQL error nobody can trace
 * back to the day the two diverged.
 */

const MIGRATIONS = join(process.cwd(), 'src/server/db/migrations');

function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS)
    .filter((name) => name.endsWith('.sql'))
    .sort();
}

/** Applies one migration file, honouring drizzle's statement separator. */
function apply(sqlite: Database.Database, file: string): void {
  const sql = readFileSync(join(MIGRATIONS, file), 'utf8');
  for (const statement of sql.split('--> statement-breakpoint')) {
    const trimmed = statement.trim();
    if (trimmed !== '') sqlite.exec(trimmed);
  }
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gorilla-migrations-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('the ladder', () => {
  it('has migrations to check', () => {
    // A guard on the guard: a suite that silently found no files would pass
    // forever while checking nothing.
    expect(migrationFiles().length).toBeGreaterThan(10);
  });

  it('applies every migration in order to an empty database', () => {
    const sqlite = new Database(join(dir, 'ladder.db'));

    try {
      for (const file of migrationFiles()) {
        expect(() => {
          apply(sqlite, file);
        }, `${file} did not apply`).not.toThrow();
      }
    } finally {
      sqlite.close();
    }
  });

  it('applies each migration to the state every earlier one produced', () => {
    const files = migrationFiles();

    // Rebuilt from scratch for each step rather than reusing one connection.
    // A migration that happens to work against a warm database and not a cold
    // one is the failure this is looking for.
    for (let upTo = 0; upTo < files.length; upTo += 1) {
      const sqlite = new Database(join(dir, `step-${String(upTo)}.db`));

      try {
        for (let index = 0; index <= upTo; index += 1) {
          const file = files[index];
          if (file !== undefined) apply(sqlite, file);
        }
      } finally {
        sqlite.close();
      }
    }
  });

  it('is numbered without gaps or repeats', () => {
    const numbers = migrationFiles().map((file) => Number(file.slice(0, 4)));

    // Drizzle applies by journal order, so a duplicate prefix is not a hard
    // error - it is two migrations one of which quietly never runs.
    expect(numbers).toEqual(numbers.map((_value, index) => index));
  });
});

describe('drift between the schema and the migrations', () => {
  /**
   * `table_xinfo`, not `table_info`.
   *
   * The plain pragma omits virtual generated columns, and four of the events
   * table's correlation columns are exactly that. Written with `table_info`
   * first, this check reported `events.tool_name` as missing from a database
   * that has it - a drift test that invents drift is worse than none.
   */
  function columnsInDatabase(sqlite: Database.Database, table: string): Set<string> {
    const rows = sqlite.prepare(`PRAGMA table_xinfo(${table})`).all() as { name: string }[];
    return new Set(rows.map((row) => row.name));
  }

  it('every table the schema declares exists, with every column', () => {
    const sqlite = new Database(join(dir, 'drift.db'));

    try {
      for (const file of migrationFiles()) apply(sqlite, file);

      const tables = Object.values(schema).filter(
        (value): value is SQLiteTable => typeof value === 'object' && value !== null,
      );

      expect(tables.length).toBeGreaterThan(5);

      for (const table of tables) {
        const config = getTableConfig(table);
        const actual = columnsInDatabase(sqlite, config.name);

        expect(actual.size, `table ${config.name} is missing`).toBeGreaterThan(0);

        for (const column of config.columns) {
          // The failure this catches typechecks perfectly: the code addresses
          // a column the database does not have, and the SQL error arrives
          // months after the day the two diverged.
          expect(actual.has(column.name), `${config.name}.${column.name} is missing`).toBe(true);
        }
      }
    } finally {
      sqlite.close();
    }
  });
});
