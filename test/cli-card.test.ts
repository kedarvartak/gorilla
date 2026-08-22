import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createCard, updateCard } from '../src/server/api/cards.js';
import { dispatchCommand, verifyCommand } from '../src/cli/commands/card.js';
import { startServer, type RunningServer } from '../src/server/start.js';

/**
 * Driving one card from a shell (T56, T57).
 *
 * These talk to the running board rather than doing the work. Dispatch belongs
 * to the process that owns the worktrees and supervises the launcher: a second
 * process starting a run would spawn an agent that dies when the command
 * exits, and the card lease would refuse it anyway.
 */

const PORT = 4487;

let dir: string;
let server: RunningServer;
let cardId: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'gorilla-cli-card-'));
  server = await startServer({
    port: PORT,
    dbPath: join(dir, 'cli.db'),
    cwd: dir,
    logger: false,
  });

  const card = createCard(server.database, {
    boardId: server.board?.id ?? '',
    title: 'a card',
    goalCondition: '`true` exits 0',
  });
  cardId = card.id;
});

afterEach(async () => {
  await server.stop();
  rmSync(dir, { recursive: true, force: true });
});

describe('verify from the shell', () => {
  it('says a card with no verify command did not run one', async () => {
    const result = await verifyCommand.run([cardId, '--port', String(PORT)]);

    // Saying nothing would read as a pass, which is the one thing it must not
    // read as.
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('no verify command');
  });

  it('runs the command the card carries', async () => {
    updateCard(server.database, cardId, { guardrails: { verify: 'true' } });

    const result = await verifyCommand.run([cardId, '--port', String(PORT)]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toLowerCase()).toContain('pass');
  });

  it('answers in json when asked', async () => {
    updateCard(server.database, cardId, { guardrails: { verify: 'true' } });

    const result = await verifyCommand.run([cardId, '--port', String(PORT), '--json']);
    const parsed = JSON.parse(result.stdout) as { ran: boolean };

    expect(parsed.ran).toBe(true);
  });
});

describe('naming a card that is not there', () => {
  it('says so rather than reporting a transport failure', async () => {
    const result = await dispatchCommand.run(['no-such-card', '--port', String(PORT)]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('No such card');
  });

  it('asks for a card when none was named', async () => {
    const result = await dispatchCommand.run(['--port', String(PORT)]);

    expect(result.stderr).toContain('gorilla dispatch <card-id>');
  });
});

describe('with no board running', () => {
  it('says dispatch belongs to the board', async () => {
    // A different port, with nothing on it. The message has to explain why
    // this is not something the command can do by itself.
    const result = await dispatchCommand.run([cardId, '--port', '4488']);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('belongs to the running board');
  });
});
