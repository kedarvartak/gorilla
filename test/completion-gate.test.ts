import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createCard, getCard, moveCard } from '../src/server/api/cards.js';
import { createDefaultColumns } from '../src/server/cards/defaults.js';
import { openDatabase, type DatabaseHandle } from '../src/server/db/client.js';
import { Dispatcher } from '../src/server/dispatch/dispatcher.js';
import { PendingBindings } from '../src/server/binding/pending.js';
import { boards, columns } from '../src/server/db/schema.js';
import { REPORT_PATH } from '../src/server/review/contract.js';

/**
 * A card does not settle because an agent said it was done.
 *
 * These drive a fake CLI that writes - or fails to write - the completion
 * report, and assert what the board does with each: one repair attempt at a
 * failure it can describe, and then a person.
 */

let dir: string;
let repo: string;
let handle: DatabaseHandle;
let dispatcher: Dispatcher;

const BOARD = 'board-1';

function fakeClaude(script: string): string {
  const path = join(dir, `fake-${Math.random().toString(36).slice(2)}.sh`);
  writeFileSync(path, `#!/usr/bin/env bash\n${script}\n`, 'utf8');
  chmodSync(path, 0o755);
  return path;
}

/** A run that edits a file and leaves whatever report the test asks for. */
function runThatWrites(report: string | null): string {
  const writeReport =
    report === null ? '' : `mkdir -p .gorilla && cat > ${REPORT_PATH} <<'JSON'\n${report}\nJSON`;

  return fakeClaude(
    `echo "changed" >> app.txt\n${writeReport}\necho '{"type":"system","session_id":"s-'$RANDOM'"}'`,
  );
}

const COMPLETE = JSON.stringify({
  summary: 'Appended a line to the app file.',
  files: [{ path: 'app.txt', why: 'The line the card asked for.' }],
  verification: { how: 'true', result: 'ok', evidence: null },
  outstanding: [],
});

function columnNamed(name: string): string {
  const found = handle.db.select().from(columns).where(eq(columns.name, name)).get();
  if (found === undefined) throw new Error(`no column ${name}`);
  return found.id;
}

function card(title: string, guardrails: unknown = {}): string {
  const created = createCard(handle, {
    boardId: BOARD,
    title,
    goalCondition: '`true` exits 0',
    guardrails,
  });
  moveCard(handle, created.id, columnNamed('Ready'), 0);
  return created.id;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gorilla-completion-'));
  repo = join(dir, 'repo');

  execFileSync('git', ['init', '-q', repo]);
  execFileSync('git', ['config', 'user.email', 't@example.com'], { cwd: repo });
  execFileSync('git', ['config', 'user.name', 'T'], { cwd: repo });
  writeFileSync(join(repo, 'app.txt'), 'original\n');
  execFileSync('git', ['add', '.'], { cwd: repo });
  execFileSync('git', ['commit', '-qm', 'initial'], { cwd: repo });

  handle = openDatabase({ path: join(dir, 'gate.db') });
  handle.db.insert(boards).values({ id: BOARD, name: 'b', cwd: repo, createdAt: 1 }).run();
  createDefaultColumns(handle.db, BOARD);

  dispatcher = new Dispatcher(handle, new PendingBindings());
});

afterEach(async () => {
  await dispatcher.shutdown();
  handle.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('finishing a card', () => {
  it('records the account when the run gives one', async () => {
    dispatcher.useExecutable(runThatWrites(COMPLETE));

    const id = card('reports properly');
    await (
      await dispatcher.dispatchIsolated(BOARD, id)
    )?.result;

    // Waited on the report rather than on the status: a card is moved to
    // `awaiting-review` the moment the process exits, which is before the
    // commit, the verify and this gate have run.
    await vi.waitFor(() => expect(getCard(handle, id).completionReport).not.toBeNull());
    expect(getCard(handle, id).status).toBe('awaiting-review');

    const stored = JSON.parse(getCard(handle, id).completionReport ?? 'null') as {
      summary: string;
      outstanding: string[];
    };
    expect(stored.summary).toContain('Appended a line');
    expect(stored.outstanding).toEqual([]);
  });

  it('uses the bounded repair budget when a run leaves no account of its work', async () => {
    const repaired: string[] = [];
    dispatcher.events.onRepaired = (_board, cardId) => repaired.push(cardId);
    dispatcher.useExecutable(runThatWrites(null));

    const id = card('says nothing');
    await (
      await dispatcher.dispatchIsolated(BOARD, id)
    )?.result;

    await vi.waitFor(() =>
      expect(dispatcher.state(BOARD).halted?.reason).toBe('incomplete-report'),
    );

    const card1 = getCard(handle, id);
    expect(card1.repairs).toBe(1);
    expect(repaired).toContain(id);
    // The repair was actually dispatched, so its one-shot instruction has
    // been consumed rather than being left for someone to move by hand.
    expect(card1.retryNote).toBeNull();
  });

  it('relaunches a failed verification repair without an operator moving the card', async () => {
    const launches = join(dir, 'launches.log');
    dispatcher.useExecutable(
      fakeClaude(`
echo launch >> ${launches}
if [ "$(wc -l < ${launches})" -eq 1 ]; then
  echo broken > app.txt
else
  echo fixed > app.txt
fi
mkdir -p .gorilla
cat > ${REPORT_PATH} <<'JSON'
${COMPLETE}
JSON
echo '{"type":"system","session_id":"s-'$RANDOM'"}'
`),
    );

    dispatcher.setPolicy(BOARD, 'unattended');
    const id = card('fixes its failed check', { verify: 'grep -qx fixed app.txt' });
    await (await dispatcher.dispatchIsolated(BOARD, id))?.result;

    await vi.waitFor(() => {
      expect(getCard(handle, id).completionReport).not.toBeNull();
      expect(getCard(handle, id).repairs).toBe(1);
      expect(execFileSync('wc', ['-l', launches], { encoding: 'utf8' })).toMatch(/^2\s/);
    });

    const settled = getCard(handle, id);
    expect(settled.status).toBe('awaiting-review');
    expect(dispatcher.state(BOARD).halted).toBeNull();
  });

  it('stops for a person once the repair budget is spent', async () => {
    dispatcher.useExecutable(runThatWrites(null));

    const id = card('never reports');
    handle.db.update(boards).set({ policyRepairAttempts: 0 }).where(eq(boards.id, BOARD)).run();

    await (
      await dispatcher.dispatchIsolated(BOARD, id)
    )?.result;

    await vi.waitFor(() =>
      expect(dispatcher.state(BOARD).halted?.reason).toBe('incomplete-report'),
    );
    expect(getCard(handle, id).status).toBe('blocked');
    expect(dispatcher.state(BOARD).halted?.detail).toContain('outstanding');
  });

  it('refuses an account that omits what is outstanding', async () => {
    dispatcher.useExecutable(
      runThatWrites(
        JSON.stringify({
          summary: 'Appended a line.',
          files: [{ path: 'app.txt', why: 'The line.' }],
          verification: { how: 'true', result: 'ok', evidence: null },
        }),
      ),
    );

    const id = card('omits outstanding');
    handle.db.update(boards).set({ policyRepairAttempts: 0 }).where(eq(boards.id, BOARD)).run();

    await (
      await dispatcher.dispatchIsolated(BOARD, id)
    )?.result;

    await vi.waitFor(() =>
      expect(dispatcher.state(BOARD).halted?.reason).toBe('incomplete-report'),
    );
    expect(getCard(handle, id).completionReport).toBeNull();
  });
});
