import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../app.js';
import { parseGuardrails } from '../cards/guardrails.js';
import { boards, cards as cardsTable, columns, ledgerEntries } from '../db/schema.js';
import { getCard, moveCard, updateCard } from './cards.js';
import { apiError, badRequest, conflict, notFound } from './errors.js';
import { markPromoted, storedEntryById } from '../ledger/store.js';
import { promoteToGuardrail, PromotionError } from '../ledger/promote.js';
import { proposeGuardrails } from '../ledger/propose.js';
import { storedEntriesFor } from '../ledger/store.js';
import { type Surprise } from '../ledger/surprises.js';
import { GATE_REACH, mergeGate, type GateCard } from '../review/gate.js';
import { describeMergeReport, mergeBranches, mergeTargetFor } from '../review/merge.js';
import { isMerging, resolveConflicts } from '../review/resolve.js';
import { fail, present, publish } from './shared.js';

/**
 * The reviewer (P4/U4).
 *
 * One action for "merge last night's branches and tell me if anything broke".
 * The operator names the cards; nothing is merged automatically, and nothing
 * is pushed.
 */
export function registerReviewRoutes(app: FastifyInstance, context: AppContext): void {
  app.post<{
    Params: { boardId: string };
    Body: { cardIds?: unknown; into?: string; verify?: string | null };
  }>('/api/boards/:boardId/review/merge', async (request, reply) => {
    const board = context.database.db
      .select()
      .from(boards)
      .where(eq(boards.id, request.params.boardId))
      .get();

    if (board === undefined) return notFound(reply, 'No such board.');

    const cardIds = Array.isArray(request.body?.cardIds)
      ? (request.body.cardIds as unknown[]).filter((id): id is string => typeof id === 'string')
      : [];

    if (cardIds.length === 0) {
      return badRequest(reply, 'Name the cards to merge.', 'cardIds');
    }

    const manager = context.dispatcher.worktreesFor(board.cwd);
    const cards: { cardId: string; title: string; branch: string; worktree?: string }[] = [];
    const missing: string[] = [];

    for (const cardId of cardIds) {
      const workspace = manager.workspaceFor(cardId);
      if (workspace === undefined) {
        missing.push(cardId);
        continue;
      }
      cards.push({
        cardId,
        title: getCard(context.database, cardId).title,
        branch: workspace.branch,
        // Passed so the reviewer can refuse a merge whose work is still sitting
        // uncommitted in the worktree, which once produced a card reading
        // "merged and verified" with nothing on the branch at all.
        worktree: workspace.path,
      });
    }

    if (cards.length === 0) {
      return reply.code(409).send({
        ...apiError('conflict', 'None of those cards has a worktree to merge.'),
        // Which ones, because the operator asked about several and needs to
        // know which of them the board could not find.
        missing,
      });
    }

    // The gate (P3). Read before anything is merged, and applied to the whole
    // request: one card with an unjudged surprise holds the batch, because a
    // partially applied merge is the state the reviewer exists to avoid.
    const gateCards: GateCard[] = [];

    for (const card of cards) {
      const response = await app.inject({ method: 'GET', url: `/api/cards/${card.cardId}/brief` });

      if (response.statusCode !== 200) {
        // Cannot tell means do not merge. Treating an unreadable brief as
        // "nothing outstanding" would make the gate silently absent exactly
        // when the card is in a state nobody has looked at.
        return reply.code(409).send({
          ...apiError(
            'refused',
            `Nothing was merged: the brief for "${card.title}" could not be read, so the board cannot tell whether anything on it is outstanding.`,
          ),
          // The gate states its own limits alongside the refusal. Dropping
          // these to fit a common shape would remove the part the operator
          // acts on.
          reach: GATE_REACH,
          blocked: [],
          outstanding: 0,
          mergedNothing: true,
        });
      }

      const brief = response.json<{ surprises?: readonly Surprise[] }>();
      gateCards.push({ ...card, surprises: brief.surprises ?? [] });
    }

    const refusal = mergeGate(gateCards);
    if (refusal !== null) return reply.code(409).send(refusal);

    const report = await mergeBranches({
      repoCwd: board.cwd,
      cards,
      ...(typeof request.body?.into === 'string' ? { into: request.body.into } : {}),
      verifyCommand: request.body?.verify ?? null,
    });

    // Merged cards move to the terminal column; the one that broke does not.
    const terminal = context.database.db
      .select()
      .from(columns)
      .where(eq(columns.boardId, board.id))
      .all()
      .find((column) => column.isTerminal);

    const mergedAt = Date.now();

    for (const step of report.steps) {
      if (step.outcome !== 'merged') continue;

      // Recorded before the move, and independently of it. A card that cannot
      // change column - usually an unfinished dependency - has still been
      // merged, and losing that fact would leave it reading as merely `done`.
      context.database.db
        .update(cardsTable)
        .set({
          mergedAt,
          mergedInto: report.into,
          mergedBranch: step.branch,
          updatedAt: mergedAt,
        })
        .where(eq(cardsTable.id, step.cardId))
        .run();

      if (terminal === undefined) continue;

      try {
        moveCard(context.database, step.cardId, terminal.id, 0);
        updateCard(context.database, step.cardId, { status: 'done' });
      } catch {
        // The report is the record; the column is a convenience.
        continue;
      }
    }

    publish(context, 'review-merged', { boardId: board.id, ...report });

    return reply.send({
      ...report,
      missing,
      summary: describeMergeReport(report),
    });
  });

  /**
   * Resolving the conflict the board is sitting in.
   *
   * A conflict is the ordinary cost of two agents working in parallel, so
   * stopping there made the one merge action fail on exactly the mornings it was
   * most needed. The board resolves it instead, then judges the result from the
   * repository rather than from what the resolver claims.
   */
  app.post<{
    Params: { boardId: string };
    Body: { branch?: string; into?: string; verify?: string | null };
  }>('/api/boards/:boardId/review/resolve', async (request, reply) => {
    const board = context.database.db
      .select()
      .from(boards)
      .where(eq(boards.id, request.params.boardId))
      .get();

    if (board === undefined) return notFound(reply, 'No such board.');

    if (!isMerging(board.cwd)) {
      return conflict(
        reply,
        'This repository is not part way through a merge, so there is nothing to resolve.',
      );
    }

    const result = await resolveConflicts({
      repoCwd: board.cwd,
      branch: request.body?.branch ?? 'the card branch',
      into: request.body?.into ?? (await mergeTargetFor(board.cwd)) ?? 'HEAD',
      verifyCommand: request.body?.verify ?? null,
    });

    publish(context, 'review-resolved', { boardId: board.id, ...result });

    // 409 for anything short of resolved: the caller asked for a merge to be
    // completed, and a report that it was not is not a success.
    return reply.code(result.outcome === 'resolved' ? 200 : 409).send(result);
  });

  /**
   * Promoting a judged entry into a rule (doc 12, output 1).
   *
   * The step that makes judgement compound. Without it an accepted assumption
   * reaches the next run as context and evaporates; as a guardrail it constrains.
   */
  /**
   * The shortlist of entries worth promoting (T14).
   *
   * The promotion machinery has existed since G1 with one caller: a human who
   * happens to remember an entry is there. Nothing has ever been promoted,
   * because finding the candidates meant reading everything the ledger holds.
   *
   * Proposals only. An entry becoming a rule without a human reading it would
   * let the ledger constrain the agent by itself, which doc 12 never allows.
   */
  app.get<{ Params: { cardId: string } }>(
    '/api/cards/:cardId/guardrail-proposals',
    (request, reply) => {
      try {
        const card = getCard(context.database, request.params.cardId);
        const entries = storedEntriesFor(context.database, card.id);

        return reply.send(proposeGuardrails(entries, parseGuardrails(card.guardrails)));
      } catch (error) {
        return fail(reply, error);
      }
    },
  );

  app.post<{
    Params: { entryId: string };
    Body: { target?: unknown; rule?: unknown };
  }>('/api/ledger/:entryId/promote', (request, reply) => {
    const { entryId } = request.params;
    const target = request.body?.target;

    if (target !== 'scope' && target !== 'prohibit' && target !== 'verify') {
      return reply
        .code(400)
        .send({ error: 'Promote to scope, prohibit or verify.', field: 'target' });
    }

    const entry = storedEntryById(context.database, entryId);
    if (entry === undefined) {
      return notFound(reply, `No such ledger entry: ${entryId}`);
    }

    const owner = context.database.db
      .select()
      .from(ledgerEntries)
      .where(eq(ledgerEntries.id, entryId))
      .get();

    if (owner === undefined) return notFound(reply, 'No such ledger entry.');

    try {
      const card = getCard(context.database, owner.cardId);
      const rule = typeof request.body?.rule === 'string' ? request.body.rule : '';

      const result = promoteToGuardrail(parseGuardrails(card.guardrails), {
        entry,
        target,
        rule,
      });

      const updated = updateCard(context.database, card.id, { guardrails: result.guardrails });
      markPromoted(context.database, entryId, rule.trim());

      publish(context, 'card-updated', present(updated));

      // The enforcement kind travels with the answer. An operator shown an
      // enforced rule when the board could only manage prompt text has been
      // told a protection exists that does not (R10).
      return reply.send({
        card: present(updated),
        enforcement: result.enforcement,
        detail: result.detail,
      });
    } catch (error) {
      if (error instanceof PromotionError) {
        return badRequest(reply, error.message, error.field);
      }
      return fail(reply, error);
    }
  });

  /** What is waiting to be merged: finished cards that still have a worktree. */
  app.get<{ Params: { boardId: string } }>(
    '/api/boards/:boardId/review/pending',
    async (request, reply) => {
      const board = context.database.db
        .select()
        .from(boards)
        .where(eq(boards.id, request.params.boardId))
        .get();

      if (board === undefined) return notFound(reply, 'No such board.');

      const manager = context.dispatcher.worktreesFor(board.cwd);

      const pending = await Promise.all(
        manager.list().map(async (workspace) => {
          const card = getCard(context.database, workspace.cardId);
          return {
            cardId: card.id,
            title: card.title,
            status: card.status,
            branch: workspace.branch,
            worktree: workspace.path,
            git: await manager.statusOf(card.id),
            verify: context.dispatcher.verifyResultFor(card.id) ?? null,
          };
        }),
      );

      return reply.send(pending.filter((entry) => entry.status !== 'done'));
    },
  );
}
