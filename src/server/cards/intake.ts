/**
 * Turning a written list into cards (T51).
 *
 * Work arrives as a list long before it arrives as a board. Someone writes ten
 * tasks in a file, or a planning conversation produces them, and getting them
 * onto the board is ten trips through a form - which is why in practice they
 * stay in the file.
 *
 * Markdown list items, because that is what people already write. Nothing
 * cleverer: a parser that inferred structure from prose would put cards on the
 * board that nobody wrote, and the operator would have to read all ten to find
 * out which.
 */

export interface ParsedCard {
  readonly title: string;
  readonly body: string;
  /**
   * The card's goal condition, written as a `goal:` line indented under the
   * item.
   *
   * Required, and null only so the parser can report which items are missing
   * one rather than throwing on the first. A card with no goal condition is
   * excluded from dispatch by `dispatchableCards`, so a file that lands ten
   * of them has added ten things to the board that the queue cannot take -
   * work in appearance only, which is doc 01's fourth failure mode wearing a
   * different hat.
   */
  readonly goalCondition: string | null;
  /** Which line it came from, so a rejection can point at it. */
  readonly line: number;
}

export interface ParseResult {
  readonly cards: readonly ParsedCard[];
  /** Lines that looked like they were meant to be cards and were not usable. */
  readonly skipped: readonly {
    readonly line: number;
    readonly text: string;
    readonly why: string;
  }[];
}

const ITEM = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/;
/** An indented continuation of the item above: its body. */
const CONTINUATION = /^\s{2,}\S/;
/**
 * `goal:` on a continuation line, which is the whole syntax.
 *
 * A key rather than a convention about which paragraph is the goal: the
 * parser must not infer structure from prose, or it puts conditions on the
 * board that nobody wrote and the operator has to read all ten to find out
 * which.
 */
const GOAL = /^goal:\s*(.+)$/i;

export function parseCardList(source: string): ParseResult {
  const cards: ParsedCard[] = [];
  const skipped: { line: number; text: string; why: string }[] = [];
  const bodies: string[][] = [];
  const goals: (string | null)[] = [];

  const lines = source.split('\n');

  for (const [index, raw] of lines.entries()) {
    const match = ITEM.exec(raw);

    if (match !== null) {
      const title = (match[1] ?? '').trim();

      if (title === '') {
        // A bullet with nothing after it. Reported rather than skipped
        // silently: it is almost always a line someone meant to finish.
        skipped.push({ line: index + 1, text: raw, why: 'the item has no text' });
        continue;
      }

      cards.push({ title, body: '', goalCondition: null, line: index + 1 });
      bodies.push([]);
      goals.push(null);
      continue;
    }

    // Indented text under the last item becomes its body. Anything else -
    // headings, prose, blank lines - is not a card and is not reported as a
    // problem either, because a plan file is mostly not a list.
    if (CONTINUATION.test(raw) && bodies.length > 0) {
      const trimmed = raw.trim();
      const goal = GOAL.exec(trimmed);

      // A goal line is not also body text. Repeating it in the body would put
      // the same sentence in front of the agent twice, in two registers.
      if (goal !== null) {
        goals[goals.length - 1] = (goal[1] ?? '').trim();
        continue;
      }

      bodies[bodies.length - 1]?.push(trimmed);
    }
  }

  return {
    cards: cards.map((card, index) => ({
      ...card,
      body: (bodies[index] ?? []).join('\n'),
      goalCondition: goals[index] ?? null,
    })),
    skipped,
  };
}

/** Items with no `goal:` line. Empty when the file is ready to add. */
export function missingGoals(result: ParseResult): readonly ParsedCard[] {
  return result.cards.filter((card) => (card.goalCondition ?? '').trim() === '');
}

/** What a dry run prints: what would happen, in the order it would happen. */
export function describePlan(result: ParseResult): string[] {
  const lines = result.cards.map(
    (card, index) =>
      `${String(index + 1)}. ${card.title}${card.body === '' ? '' : ' (+ body)'}${
        (card.goalCondition ?? '').trim() === '' ? ' - NO GOAL' : ' (+ goal)'
      }`,
  );

  for (const problem of result.skipped) {
    lines.push(`line ${String(problem.line)}: skipped, ${problem.why}`);
  }

  // Named per line, because the fix is per line. A count would leave the
  // operator diffing the file against the output to find which.
  const missing = missingGoals(result);
  if (missing.length > 0) {
    lines.push(
      '',
      `${String(missing.length)} item(s) have no goal condition, and a card without one cannot be dispatched:`,
      ...missing.map((card) => `  line ${String(card.line)}: ${card.title}`),
      '',
      'Add an indented `goal:` line under each, naming an end state, a check whose',
      'output will appear, and a bound. For example:',
      '  goal: `npm test` exits 0, or stop after 20 turns',
    );
  }

  if (result.cards.length === 0) {
    // Said plainly. A command that silently created nothing looks identical to
    // one that failed, and the operator will run it again.
    lines.push('Nothing here looks like a list item, so there is nothing to add.');
  }

  return lines;
}
