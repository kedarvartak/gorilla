import { asc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../app.js';
import { describeGuardrails, parseGuardrails } from '../cards/guardrails.js';
import { blockersFor } from '../cards/eligibility.js';
import { assessStaleness, mergedPaths } from '../cards/staleness.js';
import { boards, cards as cardsTable, runs } from '../db/schema.js';
import { describeCost, type RunCost } from '../launcher/cost.js';
import { getCard } from './cards.js';
import { buildMechanicalLedger } from '../ledger/mechanical.js';
import { checkReality, describeReality } from '../ledger/reality.js';
import { describeVerify } from '../verify/run.js';
import { mergeTargetFor } from '../review/merge.js';
import { fail, present } from './shared.js';

/**
 * Card detail (P4).
 *
 * One request returns everything the detail view needs - specification, run
 * history, and the mechanical ledger - because three round trips to render one
 * card is three chances for the panes to disagree with each other.
 */
/**
 * The stored cost, in the shape the accumulator produces.
 *
 * Rebuilt rather than stored as JSON so the columns stay queryable: the board
 * budget in T27 has to sum them across runs, and a JSON blob would make that
 * a scan.
 */
function costOf(run: {
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
  costUsd: number | null;
  turns: number | null;
  costSource: 'result' | 'messages' | null;
}): (RunCost & { readonly summary: string }) | null {
  if (run.costSource === null) return null;

  const cost: RunCost = {
    inputTokens: run.inputTokens ?? 0,
    outputTokens: run.outputTokens ?? 0,
    cacheReadTokens: run.cacheReadTokens ?? 0,
    cacheCreationTokens: run.cacheCreationTokens ?? 0,
    costUsd: run.costUsd,
    turns: run.turns,
    durationMs: null,
    source: run.costSource,
  };

  return { ...cost, summary: describeCost(cost) };
}

export function registerCardDetailRoutes(app: FastifyInstance, context: AppContext): void {
  app.get<{ Params: { cardId: string } }>('/api/cards/:cardId/detail', async (request, reply) => {
    try {
      const card = getCard(context.database, request.params.cardId);
      const guardrails = parseGuardrails(card.guardrails);

      const cardRuns = context.database.db
        .select()
        .from(runs)
        .where(eq(runs.cardId, card.id))
        .orderBy(asc(runs.startedAt))
        .all();

      const ledgers = cardRuns.map((run) => ({
        runId: run.id,
        sessionId: run.sessionId,
        startedAt: run.startedAt,
        endedAt: run.endedAt,
        // Distinguishes "the session told us it ended" from "we deduced it must
        // have". The interface must not present a deduction as a report.
        endReason: run.endReason,
        goalOutcome: run.goalOutcome,
        mode: run.mode,
        gitBranch: run.gitBranch,
        events: (
          context.database.sqlite
            .prepare('SELECT COUNT(*) AS n FROM events WHERE run_id = ?')
            .get(run.id) as { n: number }
        ).n,
        ledger: buildMechanicalLedger({ sqlite: context.database.sqlite, runId: run.id }),
        // Null for every run that predates T29, and for one whose stream
        // reported no usage. Both are "not known", which the interface must
        // not render as zero.
        cost: costOf(run),
      }));

      // Git is the only source here independent of the agent, so it is the one
      // that can contradict it (doc 08, claim versus reality).
      const board = context.database.db
        .select()
        .from(boards)
        .where(eq(boards.id, card.boardId))
        .get();
      const claimed = ledgers.flatMap((entry) => entry.ledger.changed);
      const reality =
        board === undefined
          ? null
          : await checkReality({
              cwd: board.cwd,
              headShaAtStart: cardRuns[0]?.headShaAtStart ?? null,
              claimedPaths: claimed,
            });

      // Whether the card still describes work that needs doing. Read here
      // rather than on the board, because it costs a git call per merged card
      // and the board lists everything at once.
      const board2 = context.database.db
        .select()
        .from(boards)
        .where(eq(boards.id, card.boardId))
        .get();

      const mergedCards = context.database.db
        .select()
        .from(cardsTable)
        .where(eq(cardsTable.boardId, card.boardId))
        .all()
        .filter((other) => other.id !== card.id && other.mergedAt !== null);

      const staleness =
        board2 === undefined
          ? null
          : assessStaleness({
              cardTitle: card.title,
              body: card.body,
              guardrails,
              runCount: cardRuns.length,
              repoCwd: board2.cwd,
              merged: await Promise.all(
                mergedCards.map(async (other) => ({
                  title: other.title,
                  verify: parseGuardrails(other.guardrails).verify,
                  paths: await mergedPaths(board2.cwd, other.mergedBranch),
                })),
              ),
            });

      const verify = context.dispatcher.verifyResultFor(card.id);

      // The isolated branch this card's work is sitting on, unmerged. Without
      // this the interface can describe what happened but offers no way to act
      // on it, which is where "how do I close this?" comes from.
      const manager = board === undefined ? null : context.dispatcher.worktreesFor(board.cwd);
      const workspace = manager?.workspaceFor(card.id);

      return reply.send({
        card: present(card),
        guardrails,
        guardrailDetail: describeGuardrails(guardrails),
        workspace:
          workspace === undefined
            ? null
            : {
                branch: workspace.branch,
                worktree: workspace.path,
                git: await manager?.statusOf(card.id),
              },
        mergeTarget: board === undefined ? null : await mergeTargetFor(board.cwd),
        verifyCommand: guardrails.verify ?? null,
        // What the board checked, rather than what the agent claimed.
        verify: verify ?? null,
        verifyNote: verify === undefined ? null : describeVerify(verify),
        blockers: blockersFor(context.database.db, card.id),
        staleness,
        runs: ledgers,
        reality,
        realityNotes: reality === null ? [] : describeReality(reality),
      });
    } catch (error) {
      return fail(reply, error);
    }
  });
}
