import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Every test process gets a database of its own (case study 1).
 *
 * Two `serve` tests once called the command without naming a database, so it
 * opened the operator's real `~/.gorilla/gorilla.db` and registered a board for
 * the test's working directory before failing on the busy port. Pointing
 * `GORILLA_DB_PATH` at a temporary file here covers every test, including
 * ones that spawn the built CLI (children inherit the environment), and the
 * guard flag makes `openDatabase` refuse the default path outright if some
 * test clears the variable and opens a database anyway.
 */
if (process.env['GORILLA_DB_PATH'] === undefined || process.env['GORILLA_DB_PATH'] === '') {
  process.env['GORILLA_DB_PATH'] = join(mkdtempSync(join(tmpdir(), 'gorilla-test-db-')), 'test.db');
}
process.env['GORILLA_REFUSE_DEFAULT_DB'] = '1';
