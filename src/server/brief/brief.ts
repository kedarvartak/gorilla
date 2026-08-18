import type { LedgerEntry } from '../ledger/entries.js';
import type { StoredEntry } from '../ledger/dedupe.js';
import type { VerifyResult } from '../verify/run.js';

/**
 * The brief (doc 08).
 *
 * What the operator reads on waking. The order of the sections is the design:
 * "since you last looked" comes first because it is the direct answer to doc
 * 01, and everything below it is context for a question that has already been
 * answered.
 *
 * The brief is derived and disposable. The ledger is the source of truth, and
 * regenerating this from it must always be possible.
 */

export interface BriefInput {
  readonly cardTitle: string;
  readonly cardStatus: string;
  readonly lastSeenAt: number | null;
  readonly entries: readonly StoredEntry[];
  /** When each entry was recorded, for the since-you-last-looked split. */
  readonly entryTimes: Readonly<Record<string, number>>;
  readonly changedFiles: readonly string[];
  readonly changedButUnmentioned: readonly string[];
  readonly verify: VerifyResult | null;
  readonly goalVerdict: string | null;
  readonly compactions: number;
  readonly runCount: number;
  readonly branch?: string | null;
  /**
   * Why the ledger looks the way it does, when it is not the full picture: no
   * API key, an exhausted budget, a failed call. Rendered rather than returned
   * as metadata, because a brief that is quietly mechanical-only reads exactly
   * like one where the model found nothing worth saying (doc 06, R10).
   */
  readonly extractionNote?: string | null;
}

export interface BriefSection {
  readonly title: string;
  readonly lines: readonly string[];
  /** Sections with nothing to say are kept and marked, never silently dropped. */
  readonly empty: boolean;
}

export interface Brief {
  readonly headline: string;
  readonly sections: readonly BriefSection[];
  readonly unseenCount: number;
  /** True when nothing has changed since the operator last looked. */
  readonly nothingNew: boolean;
}

/**
 * Whether an entry may still be stated as fact.
 *
 * A rejected entry is kept - deleting the operator's own evidence of what the
 * model got wrong would destroy the record doc 12's repair path reads from - but
 * it stops appearing in the sections that assert things. A brief that keeps
 * asserting a claim after the operator has said it is wrong teaches them to stop
 * believing the brief, which costs more than the claim was worth.
 */
function isAsserted(entry: StoredEntry): boolean {
  return entry.operatorStatus !== 'rejected';
}

function isUnseen(entry: StoredEntry, input: BriefInput): boolean {
  if (input.lastSeenAt === null) return true;
  const at = input.entryTimes[entry.id];
  return at === undefined ? false : at > input.lastSeenAt;
}

function statementOf(entry: LedgerEntry): string {
  return entry.alternative === undefined
    ? entry.statement
    : `${entry.statement} (rather than ${entry.alternative})`;
}

/**
 * Section one, and the reason the whole thing exists.
 *
 * When nothing has changed it says so in one line so the operator can stop
 * reading immediately. A brief that always demands two minutes gets skipped
 * when there are thirty seconds, which is the original failure returning.
 */
function sinceYouLastLooked(input: BriefInput): BriefSection {
  const unseen = input.entries.filter((entry) => isUnseen(entry, input) && isAsserted(entry));

  if (input.lastSeenAt === null) {
    return {
      title: 'Since you last looked',
      lines: ['You have not opened this card before. Everything below is new.'],
      empty: false,
    };
  }

  if (unseen.length === 0) {
    return {
      title: 'Since you last looked',
      lines: ['Nothing has changed since you last looked.'],
      empty: true,
    };
  }

  // Reversals first: the operator accepted something that is now false, which
  // is the most dangerous state the card can be in (doc 12).
  const reversals = unseen.filter(
    (entry) => entry.supersededBy !== null && entry.supersededBy !== undefined,
  );
  const decisions = unseen.filter((entry) => entry.kind === 'decision');
  const questions = unseen.filter((entry) => entry.kind === 'question');
  const risks = unseen.filter((entry) => entry.kind === 'risk');

  const lines: string[] = [];

  // Reversals are never truncated: an operator who accepted something now false
  // is the most dangerous state a card reaches, and there are rarely many.
  for (const entry of reversals) {
    lines.push(`REVERSED: ${statementOf(entry)}`);
  }
  for (const entry of decisions.slice(0, MAX_LINES_PER_SECTION)) {
    lines.push(`Decided: ${statementOf(entry)}`);
  }
  for (const entry of questions.slice(0, MAX_LINES_PER_SECTION)) {
    lines.push(`Needs you: ${entry.statement}`);
  }
  for (const entry of risks.slice(0, MAX_LINES_PER_SECTION)) {
    lines.push(`Risk: ${entry.statement}`);
  }

  const counted = reversals.length + decisions.length + questions.length + risks.length;
  if (counted < unseen.length) {
    lines.push(`…and ${unseen.length - counted} further change(s) below.`);
  }

  return { title: 'Since you last looked', lines, empty: false };
}

function stateOfTheWork(input: BriefInput, rejected: number): BriefSection {
  const lines = [`${input.cardTitle} is ${input.cardStatus}, after ${input.runCount} run(s).`];

  if (input.goalVerdict !== null) lines.push(`Goal evaluator: ${input.goalVerdict}`);

  if (input.verify !== null && input.verify.status !== 'skipped') {
    // The board ran this. It does not depend on the agent reporting honestly.
    lines.push(
      input.verify.status === 'passed'
        ? `Verify passed: \`${input.verify.command}\``
        : `Verify did NOT pass: \`${input.verify.command}\` (${input.verify.status})`,
    );
  }

  if (input.branch !== null && input.branch !== undefined && input.branch !== '') {
    lines.push(`Work is on branch ${input.branch} and has not been merged.`);
  }

  if (rejected > 0) {
    // Stated rather than hidden: "you overruled three of these" is itself
    // something the operator wants to know on returning to a card.
    lines.push(
      `You rejected ${String(rejected)} entr${rejected === 1 ? 'y' : 'ies'}; ` +
        'they are kept on the card but are no longer stated as fact below.',
    );
  }

  if (
    input.extractionNote !== null &&
    input.extractionNote !== undefined &&
    input.extractionNote !== ''
  ) {
    lines.push(input.extractionNote);
  }

  return { title: 'State of the work', lines, empty: false };
}

/**
 * How many entries a section shows before it stops listing and starts counting.
 *
 * Not arbitrary. A run that failed badly produced 68 risks and 49 questions on
 * one card, most of them paraphrases of "the agent retried instead of
 * escalating". Deduplication cannot catch those - they share only structural
 * words, and the threshold that would catch them would also collapse unrelated
 * claims - so the brief has to refuse to print them instead.
 *
 * A brief that costs twenty minutes gets skipped entirely, which is the failure
 * in doc 01 returning by a different route.
 */
export const MAX_LINES_PER_SECTION = 8;

function listSection(
  title: string,
  entries: readonly StoredEntry[],
  emptyLine: string,
): BriefSection {
  if (entries.length === 0) return { title, lines: [emptyLine], empty: true };

  const shown = entries.slice(0, MAX_LINES_PER_SECTION);
  const lines = shown.map((entry) => {
    const superseded =
      entry.supersededBy !== null && entry.supersededBy !== undefined ? ' [superseded]' : '';
    return `${statementOf(entry)}${superseded}`;
  });

  if (entries.length > shown.length) {
    const hidden = entries.length - shown.length;
    lines.push(
      `…and ${String(hidden)} more not shown. A count this high usually means one run ` +
        'repeated itself rather than that this much was decided; the entries are all ' +
        'still on the card.',
    );
  }

  return { title, lines, empty: false };
}

function blastRadius(input: BriefInput): BriefSection {
  if (input.changedFiles.length === 0) {
    return { title: 'Blast radius', lines: ['No files changed.'], empty: true };
  }

  const lines = [`${input.changedFiles.length} file(s) changed:`];
  for (const file of input.changedFiles.slice(0, 20)) lines.push(`  ${file}`);
  if (input.changedFiles.length > 20) {
    lines.push(`  …and ${input.changedFiles.length - 20} more.`);
  }

  if (input.changedButUnmentioned.length > 0) {
    // Where unobserved drift lives: nobody has a reason to look at a file no
    // one talked about.
    lines.push('');
    lines.push(
      `${input.changedButUnmentioned.length} changed without appearing in the event stream: ` +
        input.changedButUnmentioned.join(', '),
    );
  }

  return { title: 'Blast radius', lines, empty: false };
}

function continuity(input: BriefInput): BriefSection {
  if (input.compactions === 0) {
    return {
      title: 'Compaction and continuity',
      lines: ['Context was not compacted during this card.'],
      empty: true,
    };
  }

  return {
    title: 'Compaction and continuity',
    lines: [
      `Context was compacted ${input.compactions} time(s).`,
      "The agent's memory of everything before each compaction is a summary, not the original.",
    ],
    empty: false,
  };
}

export function buildBrief(input: BriefInput): Brief {
  const since = sinceYouLastLooked(input);
  const unseenCount = input.entries.filter(
    (entry) => isUnseen(entry, input) && isAsserted(entry),
  ).length;

  // Rejected entries drop out of every section below. They remain on the card,
  // and the count of them is stated rather than hidden, because "the operator
  // overruled three of these" is itself worth knowing.
  const asserted = input.entries.filter(isAsserted);
  const rejected = input.entries.length - asserted.length;

  const sections: BriefSection[] = [
    since,
    stateOfTheWork(input, rejected),
    listSection(
      'Decisions',
      asserted.filter((entry) => entry.kind === 'decision'),
      'No decisions recorded.',
    ),
    listSection(
      'Assumptions in force',
      asserted.filter(
        (entry) =>
          entry.kind === 'assumption' &&
          (entry.supersededBy === null || entry.supersededBy === undefined),
      ),
      'No assumptions recorded.',
    ),
    blastRadius(input),
    listSection(
      'Risks and open questions',
      asserted.filter((entry) => entry.kind === 'risk' || entry.kind === 'question'),
      'Nothing outstanding.',
    ),
    continuity(input),
  ];

  return {
    headline:
      unseenCount === 0 && input.lastSeenAt !== null
        ? `${input.cardTitle}: nothing new`
        : `${input.cardTitle}: ${unseenCount} new entr${unseenCount === 1 ? 'y' : 'ies'}`,
    sections,
    unseenCount,
    nothingNew: unseenCount === 0 && input.lastSeenAt !== null,
  };
}

export function renderBrief(brief: Brief): string {
  const lines = [`# ${brief.headline}`, ''];

  for (const section of brief.sections) {
    lines.push(`## ${section.title}`, '');
    for (const line of section.lines) lines.push(line);
    lines.push('');
  }

  return lines.join('\n').trimEnd();
}
