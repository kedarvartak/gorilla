import { randomUUID } from 'node:crypto';

import { asc, eq } from 'drizzle-orm';

import {
  addDependency,
  createCard,
  CardError,
  isPriority,
  PRIORITIES,
  type CardPriority,
} from './cards.js';
import { checkCondition, type GoalWarning } from '../goal/compose.js';
import { parseGuardrails } from '../cards/guardrails.js';
import type { DatabaseHandle } from '../db/client.js';
import { cards as cardsTable, columns, plans, type Card } from '../db/schema.js';

/**
 * Plan intake (doc 07 section 2).
 *
 * A planning conversation posts its decomposition here in one call. Two
 * properties matter:
 *
 * - **Nothing lands started.** Cards arrive in the first column regardless of
 *   how confident the plan was. A planning conversation feels complete at the
 *   time and frequently is not, so promotion to Ready stays an operator action.
 * - **Warnings go back into the conversation.** The endpoint validates each
 *   card and returns per-card warnings, which the planning agent reports so
 *   they can be fixed while the context is still loaded - rather than
 *   discovered on the board a day later.
 */

function readPlanPriority(value: unknown): CardPriority {
  if (!isPriority(value)) {
    throw new CardError(
      `A card's priority must be one of ${PRIORITIES.join(', ')}.`,
      400,
      'priority',
    );
  }
  return value;
}

export interface PlanCardInput {
  readonly title?: unknown;
  readonly body?: unknown;
  readonly goalCondition?: unknown;
  readonly guardrails?: unknown;
  readonly agentModel?: unknown;
  readonly agentEffort?: unknown;
  readonly synthesisModel?: unknown;
  readonly priority?: unknown;
  /** Titles of other cards in this same batch. */
  readonly dependsOn?: unknown;
}

export interface PlanInput {
  readonly sourceSessionId?: unknown;
  readonly prompt?: unknown;
  readonly cards?: unknown;
}

export interface CardWarning {
  readonly title: string;
  readonly warnings: readonly GoalWarning[];
}

export interface PlanResult {
  readonly planId: string;
  readonly cards: readonly Card[];
  /** Per-card, so the planning agent can report them where they belong. */
  readonly warnings: readonly CardWarning[];
  readonly unresolvedDependencies: readonly { title: string; missing: string }[];
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function asTitles(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim() !== '')
    : [];
}

export function createPlan(handle: DatabaseHandle, boardId: string, input: PlanInput): PlanResult {
  if (!Array.isArray(input.cards) || input.cards.length === 0) {
    throw new CardError('A plan needs at least one card.', 400, 'cards');
  }

  const intake = handle.db
    .select()
    .from(columns)
    .where(eq(columns.boardId, boardId))
    .orderBy(asc(columns.position))
    .get();

  if (intake === undefined) {
    throw new CardError(`Board ${boardId} has no columns.`, 404, 'boardId');
  }

  const planId = randomUUID();

  const created: Card[] = [];
  const warnings: CardWarning[] = [];
  const unresolvedDependencies: { title: string; missing: string }[] = [];
  const byTitle = new Map<string, string>();

  // One transaction: a plan that half-lands leaves the operator reconciling a
  // partial decomposition against a conversation that has already moved on.
  handle.sqlite.transaction(() => {
    handle.db
      .insert(plans)
      .values({
        id: planId,
        boardId,
        sourceSessionId: asString(input.sourceSessionId),
        prompt: asString(input.prompt),
        createdAt: Date.now(),
      })
      .run();

    for (const raw of input.cards as PlanCardInput[]) {
      const title = asString(raw.title);
      if (title === null) {
        throw new CardError('Every card in a plan needs a title.', 400, 'cards');
      }

      const goalCondition = asString(raw.goalCondition);

      const card = createCard(handle, {
        boardId,
        title,
        body: asString(raw.body) ?? '',
        columnId: intake.id,
        planId,
        goalCondition,
        ...(raw.guardrails === undefined ? {} : { guardrails: raw.guardrails }),
        ...(asString(raw.agentModel) === null ? {} : { agentModel: asString(raw.agentModel) }),
        ...(asString(raw.agentEffort) === null ? {} : { agentEffort: asString(raw.agentEffort) }),
        ...(asString(raw.synthesisModel) === null
          ? {}
          : { synthesisModel: asString(raw.synthesisModel) }),
        // Refused rather than defaulted. A planning agent that asked for a
        // priority and silently got `normal` would leave the operator believing
        // the batch was ordered when it was not.
        ...(raw.priority === undefined ? {} : { priority: readPlanPriority(raw.priority) }),
      });

      created.push(card);
      byTitle.set(title, card.id);

      // Checked, never rewritten. The planning agent gets the warning and can
      // fix it while the context that produced the card is still loaded.
      const cardWarnings =
        goalCondition === null
          ? [
              {
                code: 'empty' as const,
                message: 'No goal condition, so this card cannot be dispatched.',
                remedy:
                  'Add a measurable end state with a check whose output appears in the conversation.',
                severity: 'error' as const,
              },
            ]
          : checkCondition(goalCondition);

      if (cardWarnings.length > 0) warnings.push({ title, warnings: cardWarnings });
    }

    // Dependencies resolve by title within the batch, which is how a planning
    // conversation naturally refers to them.
    for (const raw of input.cards as PlanCardInput[]) {
      const title = asString(raw.title);
      if (title === null) continue;

      const cardId = byTitle.get(title);
      if (cardId === undefined) continue;

      for (const dependency of asTitles(raw.dependsOn)) {
        const dependencyId = byTitle.get(dependency.trim());
        if (dependencyId === undefined) {
          // Reported rather than failed: a mistyped title should not discard
          // an otherwise good plan.
          unresolvedDependencies.push({ title, missing: dependency.trim() });
          continue;
        }
        addDependency(handle, cardId, dependencyId);
      }
    }
  })();

  return {
    planId,
    cards: created.map((card) => ({ ...card, guardrails: card.guardrails })),
    warnings,
    unresolvedDependencies,
  };
}

export function getPlan(handle: DatabaseHandle, planId: string): { plan: unknown; cards: Card[] } {
  const plan = handle.db.select().from(plans).where(eq(plans.id, planId)).get();
  if (plan === undefined) throw new CardError(`No such plan: ${planId}`, 404);

  return {
    plan,
    cards: handle.db.select().from(cardsTable).where(eq(cardsTable.planId, planId)).all(),
  };
}

/** Summary of a card's guardrails, used in the response the agent reads back. */
export function guardrailNote(card: Card): string {
  const guardrails = parseGuardrails(card.guardrails);
  const counts = [
    guardrails.scope.length > 0 ? `${guardrails.scope.length} scope` : null,
    guardrails.prohibit.length > 0 ? `${guardrails.prohibit.length} prohibition(s)` : null,
    guardrails.verify !== null ? 'a verify command' : null,
  ].filter((part): part is string => part !== null);

  return counts.length === 0 ? 'no guardrails' : counts.join(', ');
}
