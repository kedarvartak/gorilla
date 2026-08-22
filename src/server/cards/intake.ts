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

export function parseCardList(source: string): ParseResult {
  const cards: ParsedCard[] = [];
  const skipped: { line: number; text: string; why: string }[] = [];
  const bodies: string[][] = [];

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

      cards.push({ title, body: '', line: index + 1 });
      bodies.push([]);
      continue;
    }

    // Indented text under the last item becomes its body. Anything else -
    // headings, prose, blank lines - is not a card and is not reported as a
    // problem either, because a plan file is mostly not a list.
    if (CONTINUATION.test(raw) && bodies.length > 0) {
      bodies[bodies.length - 1]?.push(raw.trim());
    }
  }

  return {
    cards: cards.map((card, index) => ({ ...card, body: (bodies[index] ?? []).join('\n') })),
    skipped,
  };
}

/** What a dry run prints: what would happen, in the order it would happen. */
export function describePlan(result: ParseResult): string[] {
  const lines = result.cards.map(
    (card, index) => `${String(index + 1)}. ${card.title}${card.body === '' ? '' : ' (+ body)'}`,
  );

  for (const problem of result.skipped) {
    lines.push(`line ${String(problem.line)}: skipped, ${problem.why}`);
  }

  if (result.cards.length === 0) {
    // Said plainly. A command that silently created nothing looks identical to
    // one that failed, and the operator will run it again.
    lines.push('Nothing here looks like a list item, so there is nothing to add.');
  }

  return lines;
}
