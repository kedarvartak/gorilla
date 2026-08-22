import { asc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../app.js';
import { describeGuardrails, parseGuardrails } from '../cards/guardrails.js';
import { blockersFor } from '../cards/eligibility.js';
import { assessStaleness, mergedPaths } from '../cards/staleness.js';
import { boards, cards as cardsTable, runs } from '../db/schema.js';
import { describeCost, type RunCost } from '../launcher/cost.js';
import { diffSummary, UNREADABLE } from '../worktree/diff.js';
import { forecastMerge, UNKNOWN as FORECAST_UNKNOWN } from '../review/forecast.js';
import { cardsTouching, claimedButNotInGit, subsystemsForCard } from '../cards/subsystems.js';
import { findContradictions } from '../cards/contradictions.js';
import { assessReadiness } from '../review/readiness.js';
import { outstandingSurprises } from '../ledger/outstanding.js';
import { storedEntriesFor } from '../ledger/store.js';
import { proposeBlastRadius, NOTHING as NOTHING_TOUCHED } from '../cards/blast-radius.js';
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

      // Assembled from what this route already gathered, not fetched again
      // (T37). A second read of the same facts is a second thing to keep in
      // step with the first.
      const outstanding = await outstandingSurprises({
        database: context.database,
        cardId: card.id,
        ...(workspace === undefined ? {} : { cwd: workspace.path }),
      });

      const diff =
        board === undefined || workspace === undefined
          ? UNREADABLE
          : await diffSummary(board.cwd, workspace.branch);

      const mergeForecast =
        board === undefined || workspace === undefined
          ? FORECAST_UNKNOWN
          : await forecastMerge(board.cwd, await mergeTargetFor(board.cwd), workspace.branch);

      const claimedNotInGit = claimedButNotInGit(context.database.sqlite, card.id);

      return reply.send({
        card: present(card),
        readiness: assessReadiness({
          verify: verify ?? null,
          verifyCommand: guardrails.verify ?? null,
          outstanding: outstanding.length,
          establishedCount: storedEntriesFor(context.database, card.id).filter(
            (entry) => entry.operatorStatus === 'accepted',
          ).length,
          diff,
          mergeForecast,
          blockers: blockersFor(context.database.db, card.id),
          claimedNotInGit,
        }),
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
        // Whether it would go in cleanly, asked before the operator commits
        // to finding out the expensive way (T39). Costs nothing: merge-tree
        // touches neither the working tree, the index, nor HEAD.
        mergeForecast,
        // What the branch actually changed (T30). Reviewing a card used to
        // mean leaving the board for a terminal, which is where the operator
        // loses the context the board exists to hold.
        diff,
        verifyCommand: guardrails.verify ?? null,
        // What the board checked, rather than what the agent claimed.
        verify: verify ?? null,
        verifyNote: verify === undefined ? null : describeVerify(verify),
        blockers: blockersFor(context.database.db, card.id),
        // What this card's work touched, and which earlier cards touched the
        // same files (T13). Empty for every card that ran before the map
        // existed - absent evidence, not evidence the card touched nothing.
        // A card scoped to something a project rule prohibits (T16). Worth a
        // look, not an error: a rule can be prohibiting a path precisely
        // because this card is the one allowed to change it.
        contradictions: findContradictions(context.database.sqlite, card.boardId, card),
        subsystems: subsystemsForCard(context.database.sqlite, card.id),
        // What a card like this one has touched before (T18). Offered only
        // while the card has no history of its own: once it has run, what it
        // actually touched outranks a guess from similar wording.
        blastRadius:
          subsystemsForCard(context.database.sqlite, card.id).length > 0
            ? NOTHING_TOUCHED
            : proposeBlastRadius(context.database.sqlite, card.boardId, card.title, card.id),
        relatedCards: cardsTouching(context.database.sqlite, card.boardId, card.id),
        // Surfaced as a question rather than an accusation: work reverted
        // before the commit and files written outside the worktree both land
        // here, and neither is a run lying.
        claimedNotInGit,
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
