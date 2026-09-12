import { existsSync } from 'node:fs';

import { and, eq, isNull } from 'drizzle-orm';
import { simpleGit, type SimpleGit } from 'simple-git';

import type { DatabaseHandle } from '../db/client.js';
import { boards, cards, plans, type Plan } from '../db/schema.js';
import { mergeBranches, type MergeReport } from './merge.js';

/**
 * The batch branch (doc 18, and the integration work).
 *
 * A night of work used to end as several branches: each card isolated in its
 * own worktree, each verified alone, and none of them ever having met. What
 * that leaves the operator is the hardest half of the job - five merges, five
 * chances of a conflict, and no answer at all to the question they actually
 * have, which is whether the batch works.
 *
 * So an approved plan owns a branch. Cards still run concurrently in their own
 * worktrees, because that isolation is what makes concurrency safe; a card
 * that finishes clean is merged onto the batch branch and the project's check
 * is run again there. A conflict between two cards therefore surfaces at the
 * moment the second one lands, with one named culprit, rather than at the end
 * with five candidates.
 *
 * The step this does not automate is the last one. Integration into the batch
 * branch is the board's business; the batch reaching the project's own branch
 * is the operator's, and it is deliberately the single approval this design
 * asks for after the plan itself.
 */

export const BATCH_PREFIX = 'gorilla/batch';

export function batchBranchFor(planId: string, prompt: string | null): string {
  const slug = (prompt ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);

  const suffix = planId.slice(0, 8);
  return slug === '' ? `${BATCH_PREFIX}/${suffix}` : `${BATCH_PREFIX}/${slug}-${suffix}`;
}

export class BatchError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = 'BatchError';
  }
}

function planOf(handle: DatabaseHandle, planId: string): Plan {
  const plan = handle.db.select().from(plans).where(eq(plans.id, planId)).get();
  if (plan === undefined) throw new BatchError(`No such plan: ${planId}`, 404);
  return plan;
}

function repoOf(handle: DatabaseHandle, boardId: string): string {
  const board = handle.db.select().from(boards).where(eq(boards.id, boardId)).get();
  if (board === undefined) throw new BatchError(`No such board: ${boardId}`, 404);
  if (!existsSync(board.cwd)) {
    throw new BatchError(`The board directory does not exist: ${board.cwd}`, 409);
  }
  return board.cwd;
}

export interface ApprovedPlan {
  readonly planId: string;
  readonly integrationBranch: string;
  readonly from: string;
  readonly cards: number;
}

/**
 * Approving a plan.
 *
 * One action for the batch rather than one per card, which is the whole claim
 * of this design: the operator reads a decomposition once, agrees to it once,
 * and the board does the rest. The branch is cut here rather than at the first
 * completion so that every card in the batch is measured against the same
 * starting point - a branch cut later would silently include whatever landed
 * on the base in between.
 */
export async function approvePlan(
  handle: DatabaseHandle,
  planId: string,
  options: { readonly git?: SimpleGit; readonly from?: string } = {},
): Promise<ApprovedPlan> {
  const plan = planOf(handle, planId);
  if (plan.approvedAt !== null && plan.integrationBranch !== null) {
    throw new BatchError('This plan is already approved.', 409);
  }

  const repo = repoOf(handle, plan.boardId);
  const git = options.git ?? simpleGit(repo);

  const from = options.from ?? (await git.status()).current ?? 'HEAD';
  const branch = batchBranchFor(planId, plan.prompt);

  try {
    await git.raw(['branch', branch, from]);
  } catch (cause) {
    throw new BatchError(`Could not create the batch branch ${branch}: ${String(cause)}`, 409);
  }

  const now = Date.now();
  handle.db
    .update(plans)
    .set({ approvedAt: now, integrationBranch: branch })
    .where(eq(plans.id, planId))
    .run();

  const inPlan = handle.db
    .select({ id: cards.id })
    .from(cards)
    .where(eq(cards.planId, planId))
    .all();

  return { planId, integrationBranch: branch, from, cards: inPlan.length };
}

/**
 * Merging one finished card onto its batch branch.
 *
 * Deliberately one card at a time rather than all of them at the end. Two
 * cards that touch the same file conflict whenever they meet, and the only
 * question is whether the operator is told at the moment the second one lands
 * - when it has one obvious cause - or the next morning, when it has five.
 *
 * Verification runs again after the merge, on the batch branch, because a card
 * that passed alone and fails beside its neighbour is the exact defect this
 * whole arrangement exists to find.
 */
export async function integrateCard(
  handle: DatabaseHandle,
  cardId: string,
  options: { readonly git?: SimpleGit } = {},
): Promise<MergeReport | null> {
  const card = handle.db.select().from(cards).where(eq(cards.id, cardId)).get();
  if (card === undefined) throw new BatchError(`No such card: ${cardId}`, 404);
  if (card.planId === null) return null;

  const plan = planOf(handle, card.planId);
  if (plan.integrationBranch === null) return null;
  if (card.integratedAt !== null) return null;
  if (card.mergedBranch === null && card.status !== 'awaiting-review') return null;

  const repo = repoOf(handle, plan.boardId);
  const board = handle.db.select().from(boards).where(eq(boards.id, plan.boardId)).get();
  const branch = card.mergedBranch ?? branchOf(handle, cardId);
  if (branch === null) return null;

  const report = await mergeBranches({
    repoCwd: repo,
    cards: [{ cardId, title: card.title, branch }],
    into: plan.integrationBranch,
    verifyCommand: board?.policyVerify ?? null,
    ...(options.git === undefined ? {} : { git: options.git }),
  });

  if (report.clean) {
    handle.db
      .update(cards)
      .set({ integratedAt: Date.now(), mergedBranch: branch })
      .where(eq(cards.id, cardId))
      .run();
  }

  return report;
}

/** A card's own branch, from the run that worked it. */
function branchOf(handle: DatabaseHandle, cardId: string): string | null {
  const row = handle.sqlite
    .prepare(
      'SELECT git_branch AS branch FROM runs WHERE card_id = ? AND git_branch IS NOT NULL ' +
        'ORDER BY started_at DESC LIMIT 1',
    )
    .get(cardId) as { branch: string } | undefined;

  return row?.branch ?? null;
}

export interface BatchStatus {
  readonly planId: string;
  readonly prompt: string | null;
  readonly integrationBranch: string | null;
  readonly approvedAt: number | null;
  readonly mergedAt: number | null;
  readonly total: number;
  readonly integrated: number;
  readonly working: number;
  readonly checking: number;
  readonly needsYou: readonly {
    readonly cardId: string;
    readonly title: string;
    readonly why: string;
  }[];
  /** One line for the top of the board. */
  readonly headline: string;
}

/**
 * What the board says about a batch before anyone opens a card.
 *
 * The counts an operator wants at a glance, and - kept separate from them -
 * the cards that need a person. A summary that folds "two agents are working"
 * together with "one card is waiting on you" reads as progress, and the thing
 * that wants a decision is the half that must not be averaged away.
 */
export function batchStatus(handle: DatabaseHandle, planId: string): BatchStatus {
  const plan = planOf(handle, planId);

  const inPlan = handle.db
    .select()
    .from(cards)
    .where(and(eq(cards.planId, planId), isNull(cards.archivedAt)))
    .all();

  const integrated = inPlan.filter((card) => card.integratedAt !== null).length;
  const working = inPlan.filter((card) => card.status === 'running').length;
  const checking = inPlan.filter(
    (card) => card.status === 'awaiting-review' && card.integratedAt === null,
  ).length;

  const needsYou = inPlan
    .filter((card) => card.status === 'blocked')
    .map((card) => ({
      cardId: card.id,
      title: card.title,
      why: outstandingOf(card.completionReport) ?? 'This card stopped and needs a decision.',
    }));

  const headline =
    plan.mergedAt !== null
      ? `Merged into ${plan.mergedInto ?? 'the project'}`
      : `${String(integrated)} of ${String(inPlan.length)} tasks integrated`;

  return {
    planId,
    prompt: plan.prompt,
    integrationBranch: plan.integrationBranch,
    approvedAt: plan.approvedAt,
    mergedAt: plan.mergedAt,
    total: inPlan.length,
    integrated,
    working,
    checking,
    needsYou,
    headline,
  };
}

/** The first thing an agent said it could not finish, for the exception list. */
function outstandingOf(report: string | null): string | null {
  if (report === null) return null;
  try {
    const parsed: unknown = JSON.parse(report);
    const outstanding = (parsed as { outstanding?: unknown }).outstanding;
    const first = Array.isArray(outstanding) ? (outstanding[0] as unknown) : null;
    return typeof first === 'string' ? first : null;
  } catch {
    return null;
  }
}

/**
 * The batch onto the project's own branch.
 *
 * The one approval after the plan. Everything up to here the board did on its
 * own; this is the checkpoint, and it is a single decision about a single
 * reviewed result rather than a decision per card.
 */
export async function mergeBatch(
  handle: DatabaseHandle,
  planId: string,
  options: { readonly into?: string; readonly git?: SimpleGit } = {},
): Promise<MergeReport> {
  const plan = planOf(handle, planId);
  if (plan.integrationBranch === null) {
    throw new BatchError('This plan has no batch branch, so there is nothing to merge.', 409);
  }

  const repo = repoOf(handle, plan.boardId);
  const board = handle.db.select().from(boards).where(eq(boards.id, plan.boardId)).get();

  const report = await mergeBranches({
    repoCwd: repo,
    cards: [{ cardId: planId, title: plan.prompt ?? 'batch', branch: plan.integrationBranch }],
    ...(options.into === undefined ? {} : { into: options.into }),
    verifyCommand: board?.policyVerify ?? null,
    ...(options.git === undefined ? {} : { git: options.git }),
  });

  if (report.clean) {
    handle.db
      .update(plans)
      .set({ mergedAt: Date.now(), mergedInto: report.into })
      .where(eq(plans.id, planId))
      .run();
  }

  return report;
}
