import type { Database } from 'better-sqlite3';

import { parseGuardrails } from './cards/guardrails.js';
import { describeSpend, spentSince, startOfDay } from './dispatch/budget.js';

/**
 * The whole board as one file (T54).
 *
 * The board is a screen, and a screen cannot be attached to anything. An
 * operator who wants to send someone the state of a project, keep a record of
 * what a week looked like, or read it on a machine that is not running the
 * server has nothing to reach for.
 *
 * Read from the database rather than from a running server, so it works when
 * nothing is serving - which is one of the times it is most wanted. That means
 * in-flight state is the last thing written down rather than what is happening
 * this second, and the export says so rather than letting the reader assume.
 */

interface CardRow {
  readonly id: string;
  readonly title: string;
  readonly body: string;
  readonly status: string;
  readonly priority: string;
  readonly columnName: string;
  readonly guardrails: string | null;
  readonly goalCondition: string | null;
  readonly mergedAt: number | null;
  readonly attempts: number;
}

function cardsFor(sqlite: Database, boardId: string): CardRow[] {
  return sqlite
    .prepare(
      `SELECT cards.id, cards.title, cards.body, cards.status, cards.priority,
              cards.guardrails, cards.goal_condition AS goalCondition,
              cards.merged_at AS mergedAt, cards.attempts,
              columns.name AS columnName
       FROM cards
       JOIN columns ON columns.id = cards.column_id
       WHERE cards.board_id = ?
       ORDER BY columns.position, cards.position`,
    )
    .all(boardId) as CardRow[];
}

function describeCard(card: CardRow, runs: number): string[] {
  const guardrails = parseGuardrails(card.guardrails);
  const lines = [`### ${card.title}`, ''];

  lines.push(
    `- Column: ${card.columnName}`,
    `- Status: ${card.status}${card.mergedAt === null ? '' : ', merged'}`,
    `- Runs: ${String(runs)}${card.attempts === 0 ? '' : `, ${String(card.attempts)} attempt(s)`}`,
  );

  if (card.priority !== 'normal') lines.push(`- Priority: ${card.priority}`);

  // Said even when absent, because a card with no goal cannot be dispatched
  // and a reader scanning for why nothing happened should not have to infer it
  // from silence.
  lines.push(`- Goal: ${card.goalCondition ?? 'none, so this card cannot be dispatched'}`);

  if (guardrails.verify !== null) lines.push(`- Verify: \`${guardrails.verify}\``);
  if (guardrails.prohibit.length > 0) lines.push(`- Prohibited: ${guardrails.prohibit.join(', ')}`);
  if (guardrails.scope.length > 0) lines.push(`- Scope: ${guardrails.scope.join(', ')}`);

  if (card.body.trim() !== '') lines.push('', card.body.trim());

  lines.push('');
  return lines;
}

export function renderBoardExport(sqlite: Database, boardId: string, now: number): string | null {
  const board = sqlite.prepare('SELECT id, name, cwd FROM boards WHERE id = ?').get(boardId) as
    { id: string; name: string; cwd: string } | undefined;

  if (board === undefined) return null;

  const cards = cardsFor(sqlite, boardId);
  const runCounts = new Map(
    (
      sqlite
        .prepare(
          'SELECT card_id AS cardId, COUNT(*) AS n FROM runs WHERE board_id = ? AND card_id IS NOT NULL GROUP BY card_id',
        )
        .all(boardId) as { cardId: string; n: number }[]
    ).map((row) => [row.cardId, row.n]),
  );

  const rules = sqlite
    .prepare('SELECT statement FROM invariants WHERE board_id = ? ORDER BY created_at')
    .all(boardId) as { statement: string }[];

  const lines = [
    `# ${board.name}`,
    '',
    `${board.cwd}`,
    '',
    `Exported ${new Date(now).toISOString()}. ${describeSpend(spentSince(sqlite, boardId, startOfDay(now)), null)}`,
    '',
    // The caveat travels with the document, because a file outlives the moment
    // it was made and nothing else in it says how old the state is.
    'Read from the board database, so anything in flight is the last state written down rather than what is happening now.',
    '',
  ];

  if (rules.length > 0) {
    lines.push('## Project rules', '', ...rules.map((rule) => `- ${rule.statement}`), '');
  }

  if (cards.length === 0) {
    lines.push('## Cards', '', 'This board has no cards.', '');
    return lines.join('\n');
  }

  // No 'Cards' heading above the columns: the columns are the cards, and a
  // heading whose only child is another heading is a level of nesting that
  // says nothing.
  let column = '';
  for (const card of cards) {
    if (card.columnName !== column) {
      column = card.columnName;
      lines.push(`## ${column}`, '');
    }
    lines.push(...describeCard(card, runCounts.get(card.id) ?? 0));
  }

  return lines.join('\n');
}
