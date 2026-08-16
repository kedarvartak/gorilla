import { sql } from 'drizzle-orm';
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

/**
 * Phase 0 storage schema (doc 05).
 *
 * Only the three entities the hook ingest path needs are defined here. Cards,
 * ledger entries and briefs arrive in Phase 1 and 2; `runs.cardId` is present
 * but unconstrained so that ingest can record a binding before the cards table
 * exists.
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
