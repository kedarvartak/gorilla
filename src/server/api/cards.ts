import { randomUUID } from 'node:crypto';

import { and, asc, eq } from 'drizzle-orm';

import { canMoveTo, wouldCycle } from '../cards/eligibility.js';
import { parseGuardrails, serialiseGuardrails } from '../cards/guardrails.js';
import type { DatabaseHandle } from '../db/client.js';
import { cardDependencies, cards, columns, type Card } from '../db/schema.js';
import { needsRenumber, positionForIndex, renumber } from './positions.js';

/**
 * Card operations.
 *
 * Kept out of the HTTP layer so the rules - ordering, dependency refusal,
 * guardrail round-tripping - are testable without a server, and so the
 * dispatcher can call exactly the same code the API does.
 */

export class CardError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly field?: string,
  ) {
    super(message);
  }
}

export interface CreateCardInput {
  readonly boardId: string;
  readonly title: string;
  readonly body?: string;
  readonly columnId?: string;
  readonly index?: number;
  readonly goalCondition?: string | null;
  readonly guardrails?: unknown;
  readonly agentModel?: string | null;
  readonly agentEffort?: string | null;
  readonly permissionMode?: string | null;
  readonly synthesisModel?: string | null;
  readonly priority?: CardPriority;
  readonly planId?: string | null;
}

export const PRIORITIES = ['high', 'normal', 'low'] as const;
export type CardPriority = (typeof PRIORITIES)[number];

export function isPriority(value: unknown): value is CardPriority {
  return typeof value === 'string' && (PRIORITIES as readonly string[]).includes(value);
}

function siblingsOf(handle: DatabaseHandle, columnId: string): { id: string; position: number }[] {
  return handle.db
    .select({ id: cards.id, position: cards.position })
    .from(cards)
    .where(eq(cards.columnId, columnId))
    .orderBy(asc(cards.position))
    .all();
}

function firstColumn(handle: DatabaseHandle, boardId: string): string {
  const column = handle.db
    .select({ id: columns.id })
    .from(columns)
    .where(eq(columns.boardId, boardId))
    .orderBy(asc(columns.position))
    .get();

  if (column === undefined) {
    throw new CardError(`Board ${boardId} has no columns.`, 409);
  }
  return column.id;
}

export function createCard(handle: DatabaseHandle, input: CreateCardInput): Card {
  const title = input.title.trim();
  if (title === '') throw new CardError('A card needs a title.', 400, 'title');

  const columnId = input.columnId ?? firstColumn(handle, input.boardId);

  const column = handle.db.select().from(columns).where(eq(columns.id, columnId)).get();
  if (column === undefined) throw new CardError(`No such column: ${columnId}`, 404, 'columnId');
  if (column.boardId !== input.boardId) {
    throw new CardError('That column belongs to a different board.', 400, 'columnId');
  }

  const now = Date.now();
  const id = randomUUID();

  handle.db
    .insert(cards)
    .values({
      id,
      boardId: input.boardId,
      columnId,
      planId: input.planId ?? null,
      title,
      body: input.body ?? '',
      position: positionForIndex(
        siblingsOf(handle, columnId),
        input.index ?? Number.MAX_SAFE_INTEGER,
      ),
      goalCondition: input.goalCondition ?? null,
      guardrails: serialiseGuardrails(parseGuardrails(JSON.stringify(input.guardrails ?? {}))),
      agentModel: input.agentModel ?? null,
      agentEffort: input.agentEffort ?? null,
      permissionMode: input.permissionMode ?? null,
      synthesisModel: input.synthesisModel ?? null,
      priority: input.priority ?? 'normal',
      createdAt: now,
      updatedAt: now,
    })
    .run();

  return getCard(handle, id);
}

export function getCard(handle: DatabaseHandle, cardId: string): Card {
  const card = handle.db.select().from(cards).where(eq(cards.id, cardId)).get();
  if (card === undefined) throw new CardError(`No such card: ${cardId}`, 404);
  return card;
}

export function listCards(handle: DatabaseHandle, boardId: string): Card[] {
  return handle.db
    .select()
    .from(cards)
    .where(eq(cards.boardId, boardId))
    .orderBy(asc(cards.position))
    .all();
}

export interface UpdateCardInput {
  readonly title?: string;
  readonly body?: string;
  readonly goalCondition?: string | null;
  readonly guardrails?: unknown;
  readonly agentModel?: string | null;
  readonly agentEffort?: string | null;
  readonly permissionMode?: string | null;
  readonly synthesisModel?: string | null;
  readonly priority?: CardPriority;
  readonly status?: Card['status'];
  /** Null clears the ceiling. Zero and negatives are refused, not treated as none. */
  readonly tokenCeiling?: number | null;
}

export function updateCard(handle: DatabaseHandle, cardId: string, input: UpdateCardInput): Card {
  const existing = getCard(handle, cardId);

  if (input.title !== undefined && input.title.trim() === '') {
    throw new CardError('A card needs a title.', 400, 'title');
  }

  // A ceiling of zero would stop every run on its first message, which reads
  // as the board being broken rather than as a limit being enforced. Null is
  // how "no ceiling" is said.
  if (
    input.tokenCeiling !== undefined &&
    input.tokenCeiling !== null &&
    (!Number.isInteger(input.tokenCeiling) || input.tokenCeiling <= 0)
  ) {
    throw new CardError(
      'A token ceiling must be a positive whole number, or null for no ceiling.',
      400,
      'tokenCeiling',
    );
  }

  handle.db
    .update(cards)
    .set({
      ...(input.title === undefined ? {} : { title: input.title.trim() }),
      ...(input.body === undefined ? {} : { body: input.body }),
      ...(input.goalCondition === undefined ? {} : { goalCondition: input.goalCondition }),
      ...(input.guardrails === undefined
        ? {}
        : { guardrails: serialiseGuardrails(parseGuardrails(JSON.stringify(input.guardrails))) }),
      ...(input.agentModel === undefined ? {} : { agentModel: input.agentModel }),
      ...(input.agentEffort === undefined ? {} : { agentEffort: input.agentEffort }),
      ...(input.permissionMode === undefined ? {} : { permissionMode: input.permissionMode }),
      ...(input.synthesisModel === undefined ? {} : { synthesisModel: input.synthesisModel }),
      ...(input.priority === undefined ? {} : { priority: input.priority }),
      ...(input.status === undefined ? {} : { status: input.status }),
      ...(input.tokenCeiling === undefined ? {} : { tokenCeiling: input.tokenCeiling }),
      updatedAt: Date.now(),
    })
    .where(eq(cards.id, existing.id))
    .run();

  return getCard(handle, cardId);
}

/**
 * Moves a card, refusing when a dependency would be skipped.
 *
 * Runs in one transaction with the renumber, so a concurrent move cannot
 * observe a column mid-renumber and compute a position against stale values.
 */
export function moveCard(
  handle: DatabaseHandle,
  cardId: string,
  columnId: string,
  index: number,
): Card {
  const card = getCard(handle, cardId);

  const decision = canMoveTo(handle.db, cardId, columnId);
  if (!decision.allowed) {
    throw new CardError(decision.reason ?? 'That move is not allowed.', 409, 'columnId');
  }

  const column = handle.db.select().from(columns).where(eq(columns.id, columnId)).get();
  if (column === undefined) throw new CardError(`No such column: ${columnId}`, 404, 'columnId');
  if (column.boardId !== card.boardId) {
    throw new CardError('That column belongs to a different board.', 400, 'columnId');
  }

  handle.sqlite.transaction(() => {
    const siblings = siblingsOf(handle, columnId).filter((sibling) => sibling.id !== cardId);
    const position = positionForIndex(siblings, index);

    handle.db
      .update(cards)
      .set({ columnId, position, updatedAt: Date.now() })
      .where(eq(cards.id, cardId))
      .run();

    const after = siblingsOf(handle, columnId);
    if (needsRenumber(after)) {
      for (const renumbered of renumber(after)) {
        handle.db
          .update(cards)
          .set({ position: renumbered.position })
          .where(eq(cards.id, renumbered.id))
          .run();
      }
    }
  })();

  return getCard(handle, cardId);
}

export function deleteCard(handle: DatabaseHandle, cardId: string): void {
  getCard(handle, cardId);
  handle.db.delete(cards).where(eq(cards.id, cardId)).run();
}

export function addDependency(
  handle: DatabaseHandle,
  cardId: string,
  dependsOnCardId: string,
): void {
  getCard(handle, cardId);
  getCard(handle, dependsOnCardId);

  if (wouldCycle(handle.db, cardId, dependsOnCardId)) {
    // Every card in a cycle becomes permanently undispatchable with nothing to
    // explain why, so it is refused here rather than discovered later.
    throw new CardError('That dependency would create a cycle.', 409, 'dependsOn');
  }

  handle.db
    .insert(cardDependencies)
    .values({ cardId, dependsOnCardId })
    .onConflictDoNothing()
    .run();
}

export function removeDependency(
  handle: DatabaseHandle,
  cardId: string,
  dependsOnCardId: string,
): void {
  handle.db
    .delete(cardDependencies)
    .where(
      and(
        eq(cardDependencies.cardId, cardId),
        eq(cardDependencies.dependsOnCardId, dependsOnCardId),
      ),
    )
    .run();
}

/** Records that the operator has looked, which "since you last looked" needs. */
export function markSeen(handle: DatabaseHandle, cardId: string, at = Date.now()): Card {
  getCard(handle, cardId);
  handle.db.update(cards).set({ lastSeenAt: at }).where(eq(cards.id, cardId)).run();
  return getCard(handle, cardId);
}
