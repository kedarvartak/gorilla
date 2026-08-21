import { randomUUID } from 'node:crypto';
import { asc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../app.js';
import { boards, ledgerEntries, runs } from '../db/schema.js';
import { getCard, listCards } from './cards.js';
import { buildMechanicalLedger } from '../ledger/mechanical.js';
import { checkReality } from '../ledger/reality.js';
import { buildBrief, renderBrief, type Brief } from '../brief/brief.js';
import { briefToMarkdown, exportFilename } from '../brief/markdown.js';
import { durationOf, summariseSubagents } from '../agents/subagents.js';
import {
  classify,
  describeWait,
  lastActivityByCard,
  DEFAULT_WINDOW_MS,
} from '../cards/activity.js';
import type { StoredEntry } from '../ledger/dedupe.js';
import {
  cursorFor,
  entryTimesFor,
  setOperatorStatus,
  storedEntriesFor,
  storedEntryById,
} from '../ledger/store.js';
import { isOperatorStatus, OPERATOR_STATUSES } from '../ledger/entries.js';
import { surprisesFor } from '../ledger/surprises.js';
import { acknowledgedPaths, PATH_ACK_PREFIX } from '../review/gate.js';
import { fail, publish } from './shared.js';

/**
 * The brief (U5, W1).
 *
 * Two sources, one shape. Mechanical entries are derived from the events on
 * every request, because they are free and always current. Model entries were
 * paid for and are read from storage. Both are `StoredEntry`, so nothing below
 * this line knows or cares which is which - apart from the note that says when
 * the second source is missing.
 */
export interface ExtractionState {
  /** False when the board has no extraction model, which the brief must say. */
  readonly configured: boolean;
  readonly tokensSpent: number;
  readonly lastOutcome: string | null;
  /** Present only when the ledger is not the full picture. */
  readonly note: string | null;
}

/** Outcomes that are the pipeline working correctly and need no explanation. */
const QUIET_OUTCOMES: ReadonlySet<string> = new Set(['extracted', 'cached', 'skipped']);

function extractionStateFor(context: AppContext, runIds: readonly string[]): ExtractionState {
  let tokensSpent = 0;
  let lastOutcome: string | null = null;
  let lastNote: string | null = null;

  for (const runId of runIds) {
    const cursor = cursorFor(context.database, runId);
    tokensSpent += cursor.tokensSpent;

    if (cursor.lastOutcome !== null) {
      lastOutcome = cursor.lastOutcome;
      lastNote = cursor.lastNote;
    }
  }

  const configured = context.extraction.configured;

  // The unconfigured case outranks any per-window note: without a model the
  // ledger holds no decisions or assumptions at all, and an operator who thinks
  // "no decisions recorded" means "no decisions were made" is worse off than
  // before (R10).
  const note = !configured
    ? 'Ledger is MECHANICAL ONLY: extraction is switched off, so nothing here records what was decided or assumed. Unset GORILLA_EXTRACTION and restart the board to synthesise through the Claude Code CLI.'
    : lastOutcome !== null && !QUIET_OUTCOMES.has(lastOutcome)
      ? (lastNote ?? `Extraction last ended as ${lastOutcome}.`)
      : null;

  return { configured, tokensSpent, lastOutcome, note };
}

export function registerBriefRoutes(app: FastifyInstance, context: AppContext): void {
  /**
   * The operator's verdict on one entry (doc 12, P2).
   *
   * `setOperatorStatus` has existed since the ledger was written and had no
   * caller at all, so the board asserted things at the operator with no way to
   * say "that is wrong". A synthesised claim nobody can correct is worse than
   * one nobody made: it teaches the operator to stop reading.
   *
   * Nothing is deleted. A rejection is evidence about the model, and doc 12's
   * repair path reads only from these verdicts.
   */
  app.post<{ Params: { entryId: string }; Body: { status?: unknown; statement?: unknown } }>(
    '/api/ledger/:entryId/status',
    (request, reply) => {
      const { entryId } = request.params;
      const status = request.body?.status;

      if (!isOperatorStatus(status)) {
        return reply.code(400).send({
          error: `Status must be one of ${OPERATOR_STATUSES.join(', ')}.`,
          field: 'status',
        });
      }

      const existing = storedEntryById(context.database, entryId);
      if (existing === undefined) {
        return reply.code(404).send({ error: `No such ledger entry: ${entryId}` });
      }

      const statement = request.body?.statement;

      if (status === 'corrected' && typeof statement !== 'string') {
        // Correcting without saying what it should be would leave the entry
        // marked as fixed and still wrong, which is worse than leaving it.
        return reply.code(400).send({
          error: 'A corrected entry needs the statement it should read instead.',
          field: 'statement',
        });
      }

      setOperatorStatus(
        context.database,
        entryId,
        status,
        typeof statement === 'string' ? statement : undefined,
      );

      const updated = storedEntryById(context.database, entryId);
      publish(context, 'ledger-judged', { entryId, status });

      return reply.send(updated);
    },
  );

  /**
   * The operator's verdict on a changed-but-unmentioned path (P3).
   *
   * Without this, a path surprise could be shown and never retired, and the
   * merge gate would hold such a card for good - a refusal with no way through
   * is not a gate, it is a wall. The acknowledgement is stored as a judged
   * ledger entry because the path has no row of its own.
   */
  app.post<{ Params: { cardId: string }; Body: { path?: unknown; status?: unknown } }>(
    '/api/cards/:cardId/surprises/path',
    (request, reply) => {
      const { cardId } = request.params;
      const path = request.body?.path;

      if (typeof path !== 'string' || path.trim() === '') {
        return reply.code(400).send({ error: 'Name the path you looked at.', field: 'path' });
      }

      const status = request.body?.status ?? 'accepted';
      if (!isOperatorStatus(status) || status === 'unreviewed') {
        return reply.code(400).send({
          error: `Status must be one of ${OPERATOR_STATUSES.filter((value) => value !== 'unreviewed').join(', ')}.`,
          field: 'status',
        });
      }

      try {
        getCard(context.database, cardId);
      } catch (error) {
        return fail(reply, error);
      }

      // The entry hangs off a run because that is what the table requires. A
      // card with no run has had no agent near it, so nothing has been recorded
      // to look at either.
      const run = context.database.db
        .select()
        .from(runs)
        .where(eq(runs.cardId, cardId))
        .orderBy(asc(runs.startedAt))
        .all()
        .at(-1);

      if (run === undefined) {
        return reply.code(409).send({
          error: 'This card has no run, so there is nothing recorded to acknowledge against.',
        });
      }

      const id = randomUUID();
      context.database.db
        .insert(ledgerEntries)
        .values({
          id,
          cardId,
          runId: run.id,
          kind: 'change',
          statement: `${PATH_ACK_PREFIX}${path}`,
          filePaths: JSON.stringify([path]),
          sourceEventIds: '[]',
          origin: 'mechanical',
          operatorStatus: status,
          createdAt: Date.now(),
        })
        .run();

      publish(context, 'surprise-acknowledged', { cardId, path, status });
      return reply.code(201).send({ id, cardId, path, status });
    },
  );

  app.get<{ Params: { cardId: string } }>('/api/cards/:cardId/brief', async (request, reply) => {
    try {
      const card = getCard(context.database, request.params.cardId);
      const board = context.database.db
        .select()
        .from(boards)
        .where(eq(boards.id, card.boardId))
        .get();

      const cardRuns = context.database.db
        .select()
        .from(runs)
        .where(eq(runs.cardId, card.id))
        .orderBy(asc(runs.startedAt))
        .all();

      // A stable identity derived from the sources, so "since you last looked"
      // survives the brief being regenerated.
      const entries: StoredEntry[] = [];
      const entryTimes: Record<string, number> = {};
      const changed: string[] = [];

      for (const run of cardRuns) {
        const ledger = buildMechanicalLedger({ sqlite: context.database.sqlite, runId: run.id });

        for (const entry of ledger.entries) {
          const id = `${run.id}:${entry.kind}:${entry.sourceEventIds.join(',')}`;
          entries.push({ ...entry, id, origin: 'mechanical' });

          const first = entry.sourceEventIds[0];
          const at =
            first === undefined
              ? run.startedAt
              : ((
                  context.database.sqlite
                    .prepare('SELECT received_at AS at FROM events WHERE id = ?')
                    .get(first) as { at: number } | undefined
                )?.at ?? run.startedAt);

          entryTimes[id] = at;
        }

        changed.push(...ledger.changed);
      }

      // Model entries: recorded once, when the window that produced them was
      // still readable. Their ids are real rows, so the operator's accept and
      // reject survive; the mechanical ids above are derived and do not.
      entries.push(...storedEntriesFor(context.database, card.id));
      Object.assign(entryTimes, entryTimesFor(context.database, card.id));

      const extraction = extractionStateFor(
        context,
        cardRuns.map((run) => run.id),
      );

      const compactions = (
        context.database.sqlite
          .prepare(
            "SELECT COUNT(*) AS n FROM events WHERE event_name = 'PreCompact' AND run_id IN (SELECT id FROM runs WHERE card_id = ?)",
          )
          .get(card.id) as { n: number }
      ).n;

      const workspacePath =
        board === undefined
          ? undefined
          : context.dispatcher.worktreesFor(board.cwd).pathFor(card.id);

      const reality =
        board === undefined
          ? null
          : await checkReality({
              cwd: workspacePath ?? board.cwd,
              headShaAtStart: cardRuns[0]?.headShaAtStart ?? null,
              claimedPaths: changed,
            });

      const workspace =
        board === undefined
          ? undefined
          : context.dispatcher.worktreesFor(board.cwd).workspaceFor(card.id);

      const brief = buildBrief({
        cardTitle: card.title,
        cardStatus: card.status,
        lastSeenAt: card.lastSeenAt,
        entries,
        entryTimes,
        changedFiles: reality?.changedFiles ?? [],
        changedButUnmentioned: reality?.changedButUnmentioned ?? [],
        verify: context.dispatcher.verifyResultFor(card.id) ?? null,
        goalVerdict: null,
        compactions,
        runCount: cardRuns.length,
        branch: workspace?.branch ?? null,
        merged:
          card.mergedAt === null || card.mergedInto === null || card.mergedBranch === null
            ? null
            : { at: card.mergedAt, into: card.mergedInto, branch: card.mergedBranch },
        extractionNote: extraction.note,
      });

      // The set the operator would regret not reading, carried alongside the
      // brief so the interface never has to work out what is outstanding.
      const seen = acknowledgedPaths(entries);
      const surprises = surprisesFor({
        cardId: card.id,
        entries,
        // A path stays changed-but-unmentioned however long the operator looks
        // at it, so the acknowledgement is applied here rather than pretending
        // the run mentioned it.
        changedButUnmentioned: (reality?.changedButUnmentioned ?? []).filter(
          (path) => !seen.has(path),
        ),
      });

      return reply.send({ ...brief, markdown: renderBrief(brief), extraction, surprises });
    } catch (error) {
      return fail(reply, error);
    }
  });

  /**
   * What the subagents on this card did (doc 05).
   *
   * A subagent is the one place work happens and leaves the operator nothing to
   * read: its context is discarded when it stops, and the parent keeps only the
   * message it returned. Files edited inside one otherwise turn up in the blast
   * radius attributed to a session that did not edit them.
   */
  app.get<{ Params: { cardId: string } }>('/api/cards/:cardId/subagents', (request, reply) => {
    try {
      const card = getCard(context.database, request.params.cardId);

      const cardRuns = context.database.db
        .select({ id: runs.id })
        .from(runs)
        .where(eq(runs.cardId, card.id))
        .orderBy(asc(runs.startedAt))
        .all();

      const summaries = cardRuns.flatMap((run) =>
        summariseSubagents(context.database.sqlite, run.id).map((summary) => ({
          ...summary,
          runId: run.id,
          // Null when the board never saw it start, which is every subagent
          // that ran before the hooks were configured. A duration inferred
          // from the first tool call would look measured and be guessed.
          durationMs: durationOf(summary),
        })),
      );

      return reply.send(summaries);
    } catch (error) {
      return fail(reply, error);
    }
  });

  /**
   * The brief as a file (doc 08, export).
   *
   * Built by asking the brief route rather than rebuilding it here. Two paths
   * that computed a brief separately would eventually disagree, and the export
   * is precisely the copy that gets pasted somewhere the board cannot correct
   * it later.
   */
  app.get<{ Params: { cardId: string } }>('/api/cards/:cardId/brief.md', async (request, reply) => {
    try {
      const card = getCard(context.database, request.params.cardId);
      const board = context.database.db
        .select()
        .from(boards)
        .where(eq(boards.id, card.boardId))
        .get();

      const response = await app.inject({
        method: 'GET',
        url: `/api/cards/${card.id}/brief`,
      });

      if (response.statusCode !== 200) {
        return reply.code(response.statusCode).send(response.json());
      }

      const markdown = briefToMarkdown({
        brief: response.json<Brief>(),
        cardId: card.id,
        boardName: board?.name ?? 'unknown board',
        generatedAt: Date.now(),
      });

      // Sent as a file rather than as JSON holding a string: the operator asked
      // for something to keep, and a filename they can find again among thirty
      // downloads is part of that.
      return reply
        .header('content-type', 'text/markdown; charset=utf-8')
        .header(
          'content-disposition',
          `attachment; filename="${exportFilename(card.title, card.id)}"`,
        )
        .send(markdown);
    } catch (error) {
      return fail(reply, error);
    }
  });

  /** The morning view: every active card, ordered by significance not time. */
  app.get<{ Params: { boardId: string }; Querystring: { since?: string } }>(
    '/api/boards/:boardId/digest',
    async (request, reply) => {
      const cards = listCards(context.database, request.params.boardId);

      // What moved overnight, kept apart from what was already sitting there.
      // Without the split a card blocked for three days reads exactly like one
      // that failed an hour ago, the list only grows, and "while you were away"
      // stops being true.
      const now = Date.now();
      const requested = Number(request.query.since);
      const cutoff =
        Number.isFinite(requested) && requested > 0 ? requested : now - DEFAULT_WINDOW_MS;
      const activity = lastActivityByCard(context.database.sqlite, request.params.boardId);

      const digest = await Promise.all(
        cards
          .filter((card) => card.status !== 'idle')
          .map(async (card) => {
            const response = await app.inject({
              method: 'GET',
              url: `/api/cards/${card.id}/brief`,
            });
            const brief: { headline: string; unseenCount: number } = response.json();

            const recency = classify(activity.get(card.id) ?? null, cutoff, now);

            return {
              cardId: card.id,
              title: card.title,
              status: card.status,
              unseen: brief.unseenCount,
              headline: brief.headline,
              verify: context.dispatcher.verifyResultFor(card.id)?.status ?? null,
              ...recency,
              waitedFor: recency.waitingForMs === null ? null : describeWait(recency.waitingForMs),
            };
          }),
      );

      // A failed verify outranks a quiet completion; unseen outranks seen. A
      // card that moved outranks one that did not at every level of urgency:
      // the standing backlog is real, but it is not news, and it was not what
      // the operator opened this screen to find out.
      const rank = (entry: (typeof digest)[number]): number =>
        (entry.recency === 'moved' ? 10_000 : 0) +
        (entry.verify === 'failed' || entry.verify === 'errored' ? 1000 : 0) +
        (entry.status === 'blocked' ? 500 : 0) +
        entry.unseen;

      return reply.send({
        since: cutoff,
        generatedAt: now,
        entries: digest.sort((a, b) => rank(b) - rank(a)),
      });
    },
  );
}
