import { eq } from 'drizzle-orm';

import type { DatabaseHandle } from '../db/client.js';
import { cards, columns, runs } from '../db/schema.js';
import { parseGuardrails } from './guardrails.js';
import { claimedPaths, looksFinished } from './staleness.js';
import type { ResyncJudge, ResyncState, ResyncSubject } from './resync-agent.js';

/**
 * Catching up with work that happened somewhere else (issue 173).
 *
 * The board only learns what its own hooks tell it. Work done in a second
 * Claude Code window, in Codex, or by hand leaves the card exactly where it
 * was - so an operator who switches harnesses accumulates a Ready column full
 * of things that are already finished, and the queue keeps offering them.
 *
 * This asks an agent. The version before it asked git: it took the files a
 * card named and looked for a single commit touching all of them, which is
 * cheap, runs on a button press, and is honest about what little it knows. It
 * was also blind to every card that names no file, could not tell a card
 * asking for a rewrite from one asking for a rename, and had nothing at all to
 * say about the abandoned cards that are the reason this button exists.
 *
 * What it is being asked has not changed. What has changed is that the thing
 * answering can read the repository, and so can say "this is done, here is the
 * function that does it" instead of "these files changed, somebody look".
 *
 * Two shapes, one path: a sweep over every card that looks suspect, and a
 * single card the operator points at. The scoped one skips the pre-filter -
 * pointing at a card is a better signal than any heuristic - and is the honest
 * way to ask about a card the sweep would never have considered.
 *
 * The destination is the agent's to choose, terminal column included. That is
 * a deliberate change of policy: the git version moved everything to the review
 * gate and never to Done, because file-level history cannot support the claim
 * that work is finished. An agent that has read the code can support it, and
 * the evidence it gives is recorded beside the move so the operator can see
 * what the claim rests on and put the card back if it is wrong.
 */

export interface ResyncFinding {
  readonly cardId: string;
  readonly title: string;
  /** Where the agent said this belongs. */
  readonly state: ResyncState;
  /** Why, in the agent's own words. */
  readonly evidence: string;
  readonly commits: readonly string[];
  /** The column it was moved to, or null when it stayed put. */
  readonly movedTo: string | null;
}

export interface ResyncReport {
  /** Cards put to the agent. */
  readonly candidates: number;
  readonly findings: readonly ResyncFinding[];
  /** The model that answered, so the operator knows what judged their board. */
  readonly model: string | null;
  /** What the sweep cost, when the CLI reported it. */
  readonly tokensSpent: number | null;
  /** Set when the agent could not be reached, instead of failing the request. */
  readonly error: string | null;
  /** One sentence, for an operator who will not read the list. */
  readonly note: string;
}

export interface ResyncOptions {
  /** False to report without moving anything. */
  readonly apply?: boolean;
  /** One card, named by an operator, instead of a sweep. */
  readonly cardId?: string | null;
}

/**
 * Which cards are worth paying to ask about.
 *
 * Abandoned first, because those are the ones an operator means: a card the
 * board gave up on is exactly where work carried on somewhere else. Then the
 * cheap staleness signal, which is the same population the "May be done" chip
 * marks - the button exists because of that chip, and asking about cards the
 * operator was never shown would be doing something else.
 *
 * Running cards are never included at any price. One is being worked on now,
 * and a verdict about a moving target is out of date before it is written.
 */
function isCandidate(
  card: typeof cards.$inferSelect,
  runCount: number,
  terminal: ReadonlySet<string>,
  repoCwd: string,
): boolean {
  if (card.archivedAt !== null) return false;
  if (card.status === 'running') return false;
  if (terminal.has(card.columnId)) return false;

  if (card.status === 'abandoned') return true;

  return looksFinished({
    body: card.body,
    guardrails: parseGuardrails(card.guardrails),
    runCount,
    repoCwd,
  });
}

function subjectFor(card: typeof cards.$inferSelect, runCount: number): ResyncSubject {
  return {
    cardId: card.id,
    title: card.title,
    body: card.body,
    goalCondition: card.goalCondition,
    paths: claimedPaths({ body: card.body, guardrails: parseGuardrails(card.guardrails) }),
    status: card.status,
    createdAt: card.createdAt,
    hasRun: runCount > 0,
  };
}

export async function resync(
  handle: DatabaseHandle,
  boardId: string,
  repoCwd: string,
  judge: ResyncJudge,
  options: ResyncOptions = {},
): Promise<ResyncReport> {
  const apply = options.apply ?? true;
  const scoped = options.cardId ?? null;

  const boardColumns = handle.db.select().from(columns).where(eq(columns.boardId, boardId)).all();
  const terminal = boardColumns.find((column) => column.isTerminal) ?? null;
  const review = boardColumns.find((column) => column.isReviewGate) ?? null;
  const terminalIds = new Set(
    boardColumns.filter((column) => column.isTerminal).map((column) => column.id),
  );

  const runCounts = new Map<string, number>();
  for (const run of handle.db.select().from(runs).where(eq(runs.boardId, boardId)).all()) {
    if (run.cardId !== null) runCounts.set(run.cardId, (runCounts.get(run.cardId) ?? 0) + 1);
  }

  const all = handle.db.select().from(cards).where(eq(cards.boardId, boardId)).all();

  // Pointing at a card is a better signal than any heuristic, so a scoped
  // resync asks about exactly that card and skips the filter entirely.
  const candidates =
    scoped === null
      ? all.filter((card) => isCandidate(card, runCounts.get(card.id) ?? 0, terminalIds, repoCwd))
      : all.filter((card) => card.id === scoped);

  if (candidates.length === 0) {
    return {
      candidates: 0,
      findings: [],
      model: null,
      tokensSpent: null,
      error: null,
      note:
        scoped === null
          ? 'No card on this board looks finished or abandoned. Nothing to catch up on.'
          : 'No such card on this board.',
    };
  }

  let judgement;
  try {
    judgement = await judge({
      repoCwd,
      cards: candidates.map((card) => subjectFor(card, runCounts.get(card.id) ?? 0)),
    });
  } catch (cause) {
    /*
     * Reported, not thrown.
     *
     * The agent is a CLI on the operator's machine that can be logged out, out
     * of quota, or absent. A resync that returned 500 would put that in a
     * toast the board immediately forgets; a report that carries the CLI's own
     * sentence puts "usage limit reached" on screen where it can be acted on.
     */
    return {
      candidates: candidates.length,
      findings: [],
      model: null,
      tokensSpent: null,
      error: (cause as Error).message,
      note: 'The resync agent could not be reached, so nothing was moved.',
    };
  }

  const byId = new Map(candidates.map((card) => [card.id, card]));
  const findings: ResyncFinding[] = [];

  for (const verdict of judgement.verdicts) {
    const card = byId.get(verdict.cardId);
    if (card === undefined) continue;

    // 'done' takes the terminal column and the status with it, because a card
    // sitting in Done still marked idle is a card the queue will offer again.
    // 'review' moves the card and leaves the status alone: the operator's
    // verdict is what resolves it, and that is what the gate is for.
    const destination =
      verdict.state === 'done' ? terminal : verdict.state === 'review' ? review : null;

    const moves = destination !== null && destination.id !== card.columnId;

    if (moves && apply) {
      handle.db
        .update(cards)
        .set({
          columnId: destination.id,
          updatedAt: Date.now(),
          ...(verdict.state === 'done' ? { status: 'done' as const } : {}),
        })
        .where(eq(cards.id, card.id))
        .run();
    }

    findings.push({
      cardId: card.id,
      title: card.title,
      state: verdict.state,
      evidence: verdict.evidence,
      commits: verdict.commits,
      movedTo: moves ? destination.name : null,
    });
  }

  const spent =
    judgement.usage === null ? null : judgement.usage.inputTokens + judgement.usage.outputTokens;

  return {
    candidates: candidates.length,
    findings,
    model: judgement.model,
    tokensSpent: spent,
    error: null,
    note: describe(findings, apply),
  };
}

/** Says what happened without overstating it, which is the whole point here. */
function describe(findings: readonly ResyncFinding[], apply: boolean): string {
  if (findings.length === 0) {
    return 'The agent read the repository and had nothing to say about these cards.';
  }

  const movedCount = findings.filter((finding) => finding.movedTo !== null).length;
  const unfinished = findings.filter((finding) => finding.state === 'unfinished').length;

  const rest =
    unfinished === 0
      ? ''
      : ` ${String(unfinished)} card(s) had no trace of their work in the repository and were left alone.`;

  if (movedCount === 0) {
    return `Nothing to move.${rest === '' ? ' Every card is already in the right column.' : rest}`.trim();
  }

  const verb = apply ? `Moved ${String(movedCount)}` : `Would move ${String(movedCount)}`;
  const done = findings.filter((finding) => finding.state === 'done' && finding.movedTo !== null);

  const claim =
    done.length === 0
      ? ''
      : ` ${String(done.length)} of them the agent judged finished - its reasoning is beside each one, and a card put back is one click.`;

  return `${verb} card(s).${claim}${rest}`.trim();
}
