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
  const unseen = input.entries.filter((entry) => isUnseen(entry, input));

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

  for (const entry of reversals) {
    lines.push(`REVERSED: ${statementOf(entry)}`);
  }
  for (const entry of decisions) lines.push(`Decided: ${statementOf(entry)}`);
  for (const entry of questions) lines.push(`Needs you: ${entry.statement}`);
  for (const entry of risks) lines.push(`Risk: ${entry.statement}`);

  const counted = reversals.length + decisions.length + questions.length + risks.length;
  if (counted < unseen.length) {
    lines.push(`…and ${unseen.length - counted} further change(s) below.`);
  }

  return { title: 'Since you last looked', lines, empty: false };
}

function stateOfTheWork(input: BriefInput): BriefSection {
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

  return { title: 'State of the work', lines, empty: false };
}

function listSection(
  title: string,
  entries: readonly StoredEntry[],
  emptyLine: string,
): BriefSection {
  if (entries.length === 0) return { title, lines: [emptyLine], empty: true };

  return {
    title,
    lines: entries.map((entry) => {
      const superseded =
        entry.supersededBy !== null && entry.supersededBy !== undefined ? ' [superseded]' : '';
      return `${statementOf(entry)}${superseded}`;
    }),
    empty: false,
  };
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
  const unseenCount = input.entries.filter((entry) => isUnseen(entry, input)).length;

  const sections: BriefSection[] = [
    since,
    stateOfTheWork(input),
    listSection(
      'Decisions',
      input.entries.filter((entry) => entry.kind === 'decision'),
      'No decisions recorded.',
    ),
    listSection(
      'Assumptions in force',
      input.entries.filter(
        (entry) =>
          entry.kind === 'assumption' &&
          (entry.supersededBy === null || entry.supersededBy === undefined),
      ),
      'No assumptions recorded.',
    ),
    blastRadius(input),
    listSection(
      'Risks and open questions',
      input.entries.filter((entry) => entry.kind === 'risk' || entry.kind === 'question'),
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
