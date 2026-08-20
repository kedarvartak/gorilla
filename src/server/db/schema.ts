import { sql } from 'drizzle-orm';
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

/**
 * Storage schema (doc 05).
 *
 * Phase 0 defined boards, runs and events. Phase 1 adds the board itself:
 * columns, cards, guardrails and plans. Ledger entries and briefs are Phase 2.
 *
 * `runs.cardId` stays deliberately unconstrained. A run is created by the hook
 * path the instant an event arrives, before anything knows which card it
 * belongs to - and an event with nowhere to go is the blind spot this product
 * exists to remove. Attribution happens afterwards.
 */

/** A board is bound to exactly one canonicalised working directory (doc 05). */
export const boards = sqliteTable(
  'boards',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    /** Canonicalised absolute path, symlinks resolved. Routes incoming events. */
    cwd: text('cwd').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [uniqueIndex('boards_cwd_unique').on(table.cwd)],
);

/**
 * One binding of one card to one Claude Code session. A session that has not
 * been claimed still gets a run, so no events are ever dropped for want of a
 * card (doc 05, inferred binding).
 */
export const runs = sqliteTable(
  'runs',
  {
    id: text('id').primaryKey(),
    boardId: text('board_id')
      .notNull()
      .references(() => boards.id, { onDelete: 'cascade' }),
    /** Null until a card claims this session. Cards land in Phase 1. */
    cardId: text('card_id'),
    sessionId: text('session_id').notNull(),
    /** 'launched' when the board spawned it, 'attached' when the operator did. */
    mode: text('mode', { enum: ['launched', 'attached'] })
      .notNull()
      .default('attached'),
    startedAt: integer('started_at').notNull(),
    endedAt: integer('ended_at'),
    endReason: text('end_reason'),
    model: text('model'),
    permissionMode: text('permission_mode'),
    goalOutcome: text('goal_outcome', {
      enum: ['met', 'impossible', 'cleared', 'abandoned'],
    }),
    transcriptPath: text('transcript_path'),
    cwd: text('cwd').notNull(),
    gitBranch: text('git_branch'),
    headShaAtStart: text('head_sha_at_start'),
    headShaAtEnd: text('head_sha_at_end'),
    /** Monotonic counter for this run's events, advanced under a transaction. */
    lastSeq: integer('last_seq').notNull().default(0),
  },
  (table) => [
    uniqueIndex('runs_session_unique').on(table.sessionId),
    index('runs_board_started').on(table.boardId, table.startedAt),
  ],
);

/**
 * The append-only raw record. Never edited, never deleted by the application
 * (doc 05). Everything synthesised later traces back to rows in this table.
 *
 * The four correlation fields are generated from the payload rather than
 * written by the ingest path: it keeps the write a single bound insert, and it
 * means a payload shape change cannot leave the columns disagreeing with the
 * JSON they came from.
 */
export const events = sqliteTable(
  'events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    runId: text('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    sessionId: text('session_id').notNull(),
    seq: integer('seq').notNull(),
    eventName: text('event_name').notNull(),
    receivedAt: integer('received_at').notNull(),
    payload: text('payload').notNull(),

    toolName: text('tool_name').generatedAlwaysAs(
      (): ReturnType<typeof sql> => sql`json_extract(payload, '$.tool_name')`,
      { mode: 'virtual' },
    ),
    toolUseId: text('tool_use_id').generatedAlwaysAs(
      (): ReturnType<typeof sql> => sql`json_extract(payload, '$.tool_use_id')`,
      { mode: 'virtual' },
    ),
    promptId: text('prompt_id').generatedAlwaysAs(
      (): ReturnType<typeof sql> => sql`json_extract(payload, '$.prompt_id')`,
      { mode: 'virtual' },
    ),
    agentId: text('agent_id').generatedAlwaysAs(
      (): ReturnType<typeof sql> => sql`json_extract(payload, '$.agent_id')`,
      { mode: 'virtual' },
    ),
  },
  (table) => [
    uniqueIndex('events_run_seq_unique').on(table.runId, table.seq),
    index('events_session_seq').on(table.sessionId, table.seq),
    index('events_name_received').on(table.eventName, table.receivedAt),
    index('events_tool_name').on(table.toolName),
    index('events_tool_use_id').on(table.toolUseId),
    index('events_prompt_id').on(table.promptId),
    index('events_agent_id').on(table.agentId),
  ],
);

export type Board = typeof boards.$inferSelect;
export type NewBoard = typeof boards.$inferInsert;
export type Run = typeof runs.$inferSelect;
export type NewRun = typeof runs.$inferInsert;
export type EventRow = typeof events.$inferSelect;
export type NewEvent = typeof events.$inferInsert;

/**
 * A column on a board. Configurable, but exactly one must be the review gate
 * and exactly one the terminal column, because the gate logic in Phase 3 needs
 * to know which (doc 05).
 */
export const columns = sqliteTable(
  'columns',
  {
    id: text('id').primaryKey(),
    boardId: text('board_id')
      .notNull()
      .references(() => boards.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    position: integer('position').notNull(),
    /** Cards here are eligible for dispatch. */
    isReady: integer('is_ready', { mode: 'boolean' }).notNull().default(false),
    /** The gate holds cards here until the operator acknowledges (Phase 3). */
    isReviewGate: integer('is_review_gate', { mode: 'boolean' }).notNull().default(false),
    isTerminal: integer('is_terminal', { mode: 'boolean' }).notNull().default(false),
  },
  (table) => [
    uniqueIndex('columns_board_position').on(table.boardId, table.position),
    index('columns_board').on(table.boardId),
  ],
);

/**
 * A plan: one batch of cards produced by one planning conversation (doc 05).
 *
 * The provenance is the point. When a card's intent is unclear three weeks
 * later, the conversation that produced it is the answer, and it should be one
 * link away rather than lost.
 */
export const plans = sqliteTable(
  'plans',
  {
    id: text('id').primaryKey(),
    boardId: text('board_id')
      .notNull()
      .references(() => boards.id, { onDelete: 'cascade' }),
    sourceSessionId: text('source_session_id'),
    prompt: text('prompt'),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [index('plans_board').on(table.boardId)],
);

/**
 * The atomic unit of work and of comprehension (doc 05).
 *
 * Guardrails are stored as structured JSON rather than free text so the
 * enforcement kind survives the round trip. An interface that cannot tell a
 * hard rule from an advisory one will present them identically, and a guardrail
 * believed to be enforced but which is not is worse than no guardrail (R10).
 */
export const cards = sqliteTable(
  'cards',
  {
    id: text('id').primaryKey(),
    boardId: text('board_id')
      .notNull()
      .references(() => boards.id, { onDelete: 'cascade' }),
    columnId: text('column_id')
      .notNull()
      .references(() => columns.id, { onDelete: 'restrict' }),
    planId: text('plan_id').references(() => plans.id, { onDelete: 'set null' }),

    title: text('title').notNull(),
    body: text('body').notNull().default(''),
    position: integer('position').notNull(),

    /** The composed text passed to /goal (doc 07 section 4). */
    goalCondition: text('goal_condition'),
    /** GuardrailSet as JSON. See src/server/cards/guardrails.ts. */
    guardrails: text('guardrails').notNull().default('{}'),

    agentModel: text('agent_model'),
    agentEffort: text('agent_effort'),
    permissionMode: text('permission_mode'),
    synthesisModel: text('synthesis_model'),

    status: text('status', {
      enum: ['idle', 'queued', 'running', 'awaiting-review', 'blocked', 'done', 'abandoned'],
    })
      .notNull()
      .default('idle'),

    /**
     * Dispatch order within a Ready column.
     *
     * Not decoration. `dispatchableCards` orders by this before position, so a
     * high-priority card genuinely runs first. A chip that said "priority" while
     * the queue ignored it would be a label the operator trusted and the system
     * did not honour, which is R10 in a different costume.
     */
    priority: text('priority', { enum: ['high', 'normal', 'low'] })
      .notNull()
      .default('normal'),

    /**
     * When the operator last opened this card. The single field the "since you
     * last looked" section is computed against, and the most direct answer this
     * schema holds to the problem in doc 01.
     */
    lastSeenAt: integer('last_seen_at'),
    acknowledgedAt: integer('acknowledged_at'),

    /**
     * Set only when the board itself merged this card's branch.
     *
     * `done` alone is ambiguous: it covers "the board merged this", "the work
     * landed another way", and "this was never needed". Those want different
     * things from the operator, and a status that cannot tell them apart makes
     * a finished board unreadable. When these are null the card is finished and
     * the board did not merge it, which is a fact rather than an absence.
     */
    mergedAt: integer('merged_at'),
    /** The branch it was merged into, named because it is not always main. */
    mergedInto: text('merged_into'),
    /** The card's own branch, kept after the worktree is gone. */
    mergedBranch: text('merged_branch'),

    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    index('cards_board').on(table.boardId),
    index('cards_column_position').on(table.columnId, table.position),
    index('cards_status').on(table.status),
    index('cards_plan').on(table.planId),
    index('cards_priority').on(table.priority),
  ],
);

/**
 * Card dependencies. A pending card with unresolved dependencies cannot be
 * dispatched (doc 05, dispatcher).
 *
 * A separate table rather than a JSON array on the card, so the dispatcher can
 * answer "what is eligible" with a query rather than by loading every card.
 */
export const cardDependencies = sqliteTable(
  'card_dependencies',
  {
    cardId: text('card_id')
      .notNull()
      .references(() => cards.id, { onDelete: 'cascade' }),
    dependsOnCardId: text('depends_on_card_id')
      .notNull()
      .references(() => cards.id, { onDelete: 'cascade' }),
  },
  (table) => [
    uniqueIndex('card_dependencies_pair').on(table.cardId, table.dependsOnCardId),
    index('card_dependencies_depends_on').on(table.dependsOnCardId),
  ],
);

export type Column = typeof columns.$inferSelect;
export type NewColumn = typeof columns.$inferInsert;
export type Plan = typeof plans.$inferSelect;
export type NewPlan = typeof plans.$inferInsert;
export type Card = typeof cards.$inferSelect;
export type NewCard = typeof cards.$inferInsert;
export type CardDependency = typeof cardDependencies.$inferSelect;

/**
 * Ledger entries that cost something to produce (doc 08).
 *
 * Mechanical entries are derived from events on demand and need no table.
 * Model entries do: they were paid for, and recomputing them on every card
 * open would spend money to answer a question already answered.
 *
 * `supersededBy` is set rather than the row being deleted. "This was decided,
 * then reversed" is frequently the most informative thing in a long run, and
 * deleting the earlier entry destroys it.
 */
export const ledgerEntries = sqliteTable(
  'ledger_entries',
  {
    id: text('id').primaryKey(),
    cardId: text('card_id')
      .notNull()
      .references(() => cards.id, { onDelete: 'cascade' }),
    runId: text('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),

    kind: text('kind', {
      enum: ['decision', 'assumption', 'change', 'risk', 'question', 'verdict'],
    }).notNull(),
    statement: text('statement').notNull(),
    detail: text('detail'),
    /** Required on a decision: the path not taken (doc 08). */
    alternative: text('alternative'),

    /** JSON arrays. Read through the ledger module, never parsed inline. */
    filePaths: text('file_paths').notNull().default('[]'),
    sourceEventIds: text('source_event_ids').notNull().default('[]'),

    origin: text('origin', { enum: ['mechanical', 'model'] })
      .notNull()
      .default('model'),
    confidence: integer('confidence'),
    model: text('model'),

    /** Points at the entry that reversed this one. Never deleted. */
    supersededBy: text('superseded_by'),
    /** The operator's judgement, which is the only human-verified signal here. */
    /**
     * The guardrail this entry became, when the operator promoted it.
     *
     * Recorded so promotion is not offered twice and so a rule can be traced
     * back to the run that discovered it - a guardrail whose origin is unknown
     * is one nobody dares remove.
     */
    promotedTo: text('promoted_to'),

    /**
     * When the operator's correction was last handed to a session.
     *
     * A correction is worth saying once. Repeating it every session start would
     * teach the agent to skim the block it most needs to read, and an operator
     * whose correction keeps reappearing cannot tell whether it landed.
     */
    correctionDeliveredAt: integer('correction_delivered_at'),

    operatorStatus: text('operator_status', {
      enum: ['unreviewed', 'accepted', 'rejected', 'corrected'],
    })
      .notNull()
      .default('unreviewed'),

    createdAt: integer('created_at').notNull(),
  },
  (table) => [
    index('ledger_card').on(table.cardId),
    index('ledger_run').on(table.runId),
    index('ledger_card_created').on(table.cardId, table.createdAt),
    index('ledger_kind').on(table.kind),
  ],
);

/**
 * What extraction has already covered, per run.
 *
 * Without it, every Stop would re-extract the whole run: the same window sent
 * again, paid for again, and deduplicated away afterwards. The cursor makes a
 * window mean "since last time".
 */
export const extractionCursors = sqliteTable('extraction_cursors', {
  runId: text('run_id')
    .primaryKey()
    .references(() => runs.id, { onDelete: 'cascade' }),
  throughSeq: integer('through_seq').notNull().default(0),
  /** Output tokens spent on this run, for the budget. */
  tokensSpent: integer('tokens_spent').notNull().default(0),
  lastOutcome: text('last_outcome'),
  lastNote: text('last_note'),
  updatedAt: integer('updated_at').notNull(),
});

export type LedgerEntryRow = typeof ledgerEntries.$inferSelect;
export type NewLedgerEntryRow = typeof ledgerEntries.$inferInsert;
export type ExtractionCursor = typeof extractionCursors.$inferSelect;
