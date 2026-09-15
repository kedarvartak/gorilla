import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The completion contract (doc 18, and the automatic-completion work).
 *
 * A run that exits zero has told the board one thing: the process ended. It
 * has not said what changed, whether the change is what was asked for, or
 * what the agent knows it left undone. Those were recoverable only by reading
 * a transcript, which is the work this product exists to remove - so a card
 * that settles on an agent's own "done" is the fourth failure mode of doc 01
 * with a green tick on it.
 *
 * So finishing is a contract with four terms, and the board holds the agent to
 * all of them:
 *
 * - **summary** - a short account of what changed.
 * - **files** - what was touched and why each one.
 * - **verification** - what was run, what it said, and where the evidence is.
 * - **outstanding** - what is incomplete or needs a decision.
 *
 * `outstanding` is the term that has to be explicit rather than merely
 * present-if-nonempty, and it is the reason this module exists at all: an
 * agent that omits it and an agent with nothing to report produce byte
 * identical reports, so silence has to be spent rather than assumed. Saying
 * "nothing is outstanding" is a claim the operator can hold someone to. Saying
 * nothing is not.
 *
 * The board never takes the report's word for the code. The diff and the
 * verify result come from git and from the board's own run; this checks that
 * the account an agent gave is complete and is about the work that actually
 * happened.
 */

/** Where an agent leaves its report, relative to its worktree. */
export const REPORT_PATH = '.gorilla/report.json';

export interface ReportedFile {
  readonly path: string;
  /** Why this file was touched. A path with no reason is a diff, not an account. */
  readonly why: string;
}

export interface ReportedVerification {
  /** What was run. */
  readonly how: string;
  /** What it said. */
  readonly result: string;
  /** Where the evidence lives: a log, a screenshot, a report directory. */
  readonly evidence: string | null;
}

export interface AgentReport {
  readonly summary: string;
  readonly files: readonly ReportedFile[];
  readonly verification: ReportedVerification;
  /**
   * What is incomplete or needs a decision. Empty means the agent said there
   * is nothing, which is a different fact from the agent not having said.
   */
  readonly outstanding: readonly string[];
}

/** What the board saw for itself, as against what the agent said. */
export interface BoardEvidence {
  /** Paths in the branch diff, from git. */
  readonly changedPaths: readonly string[];
  /** The board's own verify result, when one was configured. */
  readonly verifyStatus: 'passed' | 'failed' | 'errored' | 'skipped' | null;
}

export type Verdict =
  | { readonly ok: true; readonly report: AgentReport; readonly discrepancies: readonly string[] }
  | { readonly ok: false; readonly missing: readonly string[]; readonly why: string };

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/**
 * Reads the report an agent left in its worktree.
 *
 * Returns null for "there is no report" - typed as `unknown`, which already
 * covers it - and throws for nothing: a malformed
 * report is the same problem as a missing one from the operator's side, and
 * both are answered by asking for it again rather than by an exception in the
 * dispatcher.
 */
export function readReport(worktree: string): unknown {
  try {
    return JSON.parse(readFileSync(join(worktree, REPORT_PATH), 'utf8')) as unknown;
  } catch {
    return null;
  }
}

/**
 * Whether this card may settle.
 *
 * Every term is required. The looser rule - accept what is there, record what
 * is not - was considered and rejected: a contract that is satisfied by an
 * empty report is a contract in name, and the board would go on presenting
 * cards as finished on exactly the evidence that made them unreviewable.
 */
export function maySettle(raw: unknown, evidence: BoardEvidence): Verdict {
  if (raw === null || typeof raw !== 'object') {
    return {
      ok: false,
      missing: ['summary', 'files', 'verification', 'outstanding'],
      why: `No completion report at ${REPORT_PATH}. A run that ends without one has said only that the process exited.`,
    };
  }

  const body = raw as Record<string, unknown>;
  const missing: string[] = [];

  /*
   * The report is not part of the work it describes.
   *
   * It is written into the worktree and committed with everything else, so
   * git reports it as a changed file like any other. Left in, it would be a
   * discrepancy on every card ("changed and not mentioned"), and on a card
   * whose only change was the report it would be the sole evidence - so an
   * account of real work would be refused for naming no file the branch
   * changed, on the strength of the account itself.
   */
  const changedPaths = evidence.changedPaths.filter((path) => !path.endsWith(REPORT_PATH));

  const summary = text(body.summary);
  if (summary === null) missing.push('summary');

  const files: ReportedFile[] = Array.isArray(body.files)
    ? body.files
        .map((entry) => {
          const file = entry as Record<string, unknown>;
          const path = text(file.path);
          const why = text(file.why);
          return path === null || why === null ? null : { path, why };
        })
        .filter((file): file is ReportedFile => file !== null)
    : [];
  if (files.length === 0) missing.push('files');

  const rawVerification = (body.verification ?? {}) as Record<string, unknown>;
  const how = text(rawVerification.how);
  const result = text(rawVerification.result);
  if (how === null || result === null) missing.push('verification');

  /*
   * Presence, not contents.
   *
   * This is the one term where the absent case and the empty case have to be
   * told apart, so it is read from whether the key was written at all. An
   * agent with nothing outstanding writes an empty list and has thereby said
   * so; an agent that omits the key has not been asked a question it answered.
   */
  const declared = Object.hasOwn(body, 'outstanding');
  const outstanding = Array.isArray(body.outstanding)
    ? body.outstanding.map((item) => text(item)).filter((item): item is string => item !== null)
    : [];
  if (!declared) missing.push('outstanding');

  if (missing.length > 0) {
    return {
      ok: false,
      missing,
      why: `The completion report is missing ${missing.join(', ')}.`,
    };
  }

  if (summary === null || how === null || result === null) {
    // Unreachable: each of these was pushed onto `missing` above, which
    // returned. Written out because the alternative is asserting it with a
    // cast, and a cast here would be the one place a malformed report could
    // reach the operator as a complete one.
    return { ok: false, missing, why: 'The completion report is incomplete.' };
  }

  /*
   * The account has to be about the work that happened.
   *
   * Not a path-by-path match: an agent describing `src/auth/` for a change in
   * `src/auth/session.ts` has given a true account, and a board that refused
   * it would be enforcing a format rather than a claim. But an account with no
   * overlap at all is about some other piece of work, and that is the failure
   * this check exists for - a plausible report of a change nobody made.
   */
  if (changedPaths.length > 0) {
    const overlaps = files.some((file) =>
      changedPaths.some((changed) => changed.includes(file.path) || file.path.includes(changed)),
    );

    if (!overlaps) {
      return {
        ok: false,
        missing: ['files'],
        why:
          'The report names no file the branch actually changed. ' +
          `The branch touched ${changedPaths.slice(0, 3).join(', ')}.`,
      };
    }
  }

  // Recorded rather than refused. A file changed and not described is worth
  // the operator's eye, and is frequently the incidental edit that turns out
  // to matter - but it is not grounds to send an otherwise complete account
  // back to be rewritten.
  const described = new Set(files.map((file) => file.path));
  const discrepancies = changedPaths
    .filter((changed) => ![...described].some((path) => changed.includes(path)))
    .map((changed) => `${changed} was changed and the report does not mention it.`);

  return {
    ok: true,
    report: {
      summary,
      files,
      verification: { how, result, evidence: text(rawVerification.evidence) },
      outstanding,
    },
    discrepancies,
  };
}

/** What the agent is told when its report is sent back. */
export function describeVerdict(verdict: Verdict): string {
  if (verdict.ok) {
    return verdict.report.outstanding.length === 0
      ? 'The run reported nothing outstanding.'
      : `The run reported ${String(verdict.report.outstanding.length)} thing(s) outstanding.`;
  }

  return (
    `${verdict.why}\n\n` +
    `Write ${REPORT_PATH} before finishing. Every field is required, and ` +
    '`outstanding` must be written even when it is empty - an omitted field ' +
    'and nothing to report are indistinguishable, so the empty list is how ' +
    'you say there is nothing.'
  );
}
