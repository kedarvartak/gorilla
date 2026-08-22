import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { addCommand } from '../src/cli/commands/add.js';
import { describePlan, parseCardList } from '../src/server/cards/intake.js';
import { listCards } from '../src/server/api/cards.js';
import { startServer, type RunningServer } from '../src/server/start.js';

/**
 * Turning a written list into cards (T51).
 *
 * Work arrives as a list long before it arrives as a board, and getting ten
 * tasks onto it is ten trips through a form - which is why in practice they
 * stay in the file.
 */

const PORT = 4489;

let dir: string;
let file: string;

describe('reading a list', () => {
  it('takes dashes, stars and numbers', () => {
    const parsed = parseCardList('- one\n* two\n1. three\n2) four');

    expect(parsed.cards.map((card) => card.title)).toEqual(['one', 'two', 'three', 'four']);
  });

  it('takes indented text under an item as its body', () => {
    const parsed = parseCardList('- a card\n    with more to say\n- another');

    expect(parsed.cards[0]?.body).toBe('with more to say');
    expect(parsed.cards[1]?.body).toBe('');
  });

  it('ignores headings and prose without complaining', () => {
    // A plan file is mostly not a list. Reporting every prose line as a
    // problem would bury the one line that is actually wrong.
    const parsed = parseCardList('# Heading\n\nSome prose.\n\n- the only card');

    expect(parsed.cards).toHaveLength(1);
    expect(parsed.skipped).toHaveLength(0);
  });

  it('reports a bullet with nothing after it', () => {
    // Almost always a line somebody meant to finish.
    const parsed = parseCardList('- \n- a real one');

    expect(parsed.cards).toHaveLength(1);
    expect(parsed.skipped[0]?.why).toContain('no text');
  });

  it('says plainly when a file holds no list at all', () => {
    // A command that silently created nothing looks identical to one that
    // failed, and the operator will run it again.
    expect(describePlan(parseCardList('just prose')).join(' ')).toContain('nothing to add');
  });

  it('does not infer structure from prose', () => {
    // A parser that guessed would put cards on the board nobody wrote, and the
    // operator would have to read all ten to find out which.
    expect(parseCardList('First do this. Then do that.').cards).toEqual([]);
  });
});

describe('adding them', () => {
  let server: RunningServer;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'gorilla-intake-'));
    file = join(dir, 'plan.md');
    server = await startServer({ port: PORT, dbPath: join(dir, 'i.db'), cwd: dir, logger: false });
  });

  afterEach(async () => {
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it('puts every item on the board', async () => {
    writeFileSync(file, '- first card\n- second card\n');

    const result = await addCommand.run(['--file', file, '--port', String(PORT)]);

    expect(result.exitCode).toBe(0);
    const titles = listCards(server.database, server.board?.id ?? '').map((card) => card.title);
    expect(titles).toEqual(['first card', 'second card']);
  });

  it('changes nothing on a dry run', async () => {
    writeFileSync(file, '- would be a card\n');

    await addCommand.run(['--file', file, '--port', String(PORT), '--dry-run']);

    expect(listCards(server.database, server.board?.id ?? '')).toHaveLength(0);
  });

  it('reports a duplicate rather than hiding it', async () => {
    writeFileSync(file, '- Record what a run cost\n- Record what a run costs\n');

    const result = await addCommand.run(['--file', file, '--port', String(PORT)]);

    // The board added it anyway, and the operator should know it did.
    expect(result.stdout).toContain('Added anyway');
  });

  it('asks for a file when none was named', async () => {
    const result = await addCommand.run(['--port', String(PORT)]);

    expect(result.stderr).toContain('--file');
  });
});

describe('with no board running', () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gorilla-intake-off-'));
    file = join(dir, 'plan.md');
    writeFileSync(file, '- a card\n');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('says why the cards go through the board', async () => {
    const result = await addCommand.run(['--file', file, '--port', '4490']);

    // A card written behind the server's back never publishes on the stream,
    // so an open board would not show it until somebody reloaded.
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('so an open interface sees them arrive');
  });

  it('still does a dry run', async () => {
    // Checking what a command will do should not need a board running.
    const result = await addCommand.run(['--file', file, '--port', '4490', '--dry-run']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('a card');
  });
});
