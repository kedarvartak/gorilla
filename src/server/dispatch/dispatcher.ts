import { eq } from 'drizzle-orm';

import { getCard, updateCard } from '../api/cards.js';
import { dispatchableCards } from '../cards/eligibility.js';
import { parseGuardrails } from '../cards/guardrails.js';
import type { DatabaseHandle } from '../db/client.js';
import { boards, cards, columns } from '../db/schema.js';
import {
  launch,
  LaunchRegistry,
  type LaunchResult,
  type RunningLaunch,
} from '../launcher/launcher.js';

/**
 * Decides which Ready card starts next (doc 05).
 *
 * Deliberately simple, and the simplicity is the design. Serial by default,
 * because two agents running at once doubles what the operator has to
 * resynchronise with - which is the cost this product exists to reduce (P1).
 * Concurrency is a per-board setting with a low default, not an architectural
 * assumption.
 *
 * The important behaviour is what it does when something goes wrong: it stops.
 * Working through a queue while an earlier card sits unreviewed means later
 * cards build on an unvalidated assumption, and a queue that halted silently
 * looks exactly like a queue that finished.
 */

export type DispatchMode = 'manual' | 'automatic';

export type HaltReason = 'failure' | 'cancelled' | 'awaiting-review' | 'no-goal' | 'launch-error';

export interface HaltState {
  readonly reason: HaltReason;
  readonly cardId: string;
  readonly cardTitle: string;
  readonly detail: string;
  readonly at: number;
}

export interface BoardDispatchState {
  readonly mode: DispatchMode;
  readonly concurrency: number;
  readonly running: readonly string[];
  readonly halted: HaltState | null;
}

export interface DispatcherEvents {
  readonly onStateChange?: (boardId: string, state: BoardDispatchState) => void;
  readonly onRunStarted?: (boardId: string, cardId: string, sessionId: string | null) => void;
  readonly onRunFinished?: (boardId: string, cardId: string, result: LaunchResult) => void;
}

interface BoardState {
  mode: DispatchMode;
  concurrency: number;
  running: Map<string, RunningLaunch>;
  halted: HaltState | null;
}

export const DEFAULT_CONCURRENCY = 1;

export class Dispatcher {
  readonly #boards = new Map<string, BoardState>();
  readonly #registry = new LaunchRegistry();
  #executable: string | undefined;

  constructor(
    private readonly database: DatabaseHandle,
    private readonly events: DispatcherEvents = {},
  ) {}

  /** Test seam: substitutes the `claude` binary. */
  useExecutable(executable: string | undefined): void {
    this.#executable = executable;
  }

  #stateFor(boardId: string): BoardState {
    const existing = this.#boards.get(boardId);
    if (existing !== undefined) return existing;

    const created: BoardState = {
      mode: 'manual',
      concurrency: DEFAULT_CONCURRENCY,
      running: new Map(),
      halted: null,
    };
    this.#boards.set(boardId, created);
    return created;
  }

  state(boardId: string): BoardDispatchState {
    const state = this.#stateFor(boardId);
    return {
      mode: state.mode,
      concurrency: state.concurrency,
      running: [...state.running.keys()],
      halted: state.halted,
    };
  }

  #publish(boardId: string): void {
    this.events.onStateChange?.(boardId, this.state(boardId));
  }

  setMode(boardId: string, mode: DispatchMode): BoardDispatchState {
    this.#stateFor(boardId).mode = mode;
    this.#publish(boardId);

    if (mode === 'automatic') this.pump(boardId);
    return this.state(boardId);
  }

  setConcurrency(boardId: string, concurrency: number): BoardDispatchState {
    this.#stateFor(boardId).concurrency = Math.max(1, Math.floor(concurrency));
    this.#publish(boardId);
    return this.state(boardId);
  }

  /**
   * Clears a halt. Deliberately explicit: the operator has to say they have
   * looked, which is the whole point of stopping.
   */
  resume(boardId: string): BoardDispatchState {
    this.#stateFor(boardId).halted = null;
    this.#publish(boardId);

    if (this.#stateFor(boardId).mode === 'automatic') this.pump(boardId);
    return this.state(boardId);
  }

  #halt(boardId: string, halt: HaltState): void {
    const state = this.#stateFor(boardId);
    // The first halt is the one that matters; later failures are consequences.
    if (state.halted === null) {
      state.halted = halt;
      this.#publish(boardId);
    }
  }

  /** Starts eligible cards up to the concurrency limit. */
  pump(boardId: string): string[] {
    const state = this.#stateFor(boardId);
    if (state.halted !== null) return [];
    if (state.mode !== 'automatic') return [];

    const started: string[] = [];

    while (state.running.size < state.concurrency && state.halted === null) {
      const next = dispatchableCards(this.database.db, boardId)[0];
      if (next === undefined) break;

      const launched = this.dispatch(boardId, next.id);
      if (launched === null) break;
      started.push(next.id);
    }

    return started;
  }

  /**
   * Dispatches one card. Returns null when it could not start, having recorded
   * why - a card that silently fails to launch is worse than one that fails.
   */
  dispatch(boardId: string, cardId: string): RunningLaunch | null {
    const state = this.#stateFor(boardId);
    const card = getCard(this.database, cardId);

    if (state.running.has(cardId)) return null;

    const board = this.database.db.select().from(boards).where(eq(boards.id, boardId)).get();
    if (board === undefined) return null;

    if (card.goalCondition === null || card.goalCondition.trim() === '') {
      // Refusing is right: a card with no condition would run against its body
      // with no definition of done, which is precisely the unbounded run the
      // goal machinery exists to avoid.
      this.#halt(boardId, {
        reason: 'no-goal',
        cardId,
        cardTitle: card.title,
        detail: 'The card has no goal condition, so there is no definition of done.',
        at: Date.now(),
      });
      return null;
    }

    updateCard(this.database, cardId, { status: 'running' });

    const running = this.#registry.track(
      launch({
        cwd: board.cwd,
        title: card.title,
        body: card.body,
        guardrails: parseGuardrails(card.guardrails),
        goalCondition: card.goalCondition,
        agentModel: card.agentModel,
        agentEffort: card.agentEffort,
        permissionMode: card.permissionMode,
        cardId,
        ...(this.#executable === undefined ? {} : { executable: this.#executable }),
        onSessionId: (sessionId) => this.events.onRunStarted?.(boardId, cardId, sessionId),
      }),
    );

    state.running.set(cardId, running);
    this.#publish(boardId);

    void running.result.then(
      (result) => this.#settle(boardId, cardId, result),
      () => this.#settle(boardId, cardId, null),
    );

    return running;
  }

  #settle(boardId: string, cardId: string, result: LaunchResult | null): void {
    const state = this.#stateFor(boardId);
    state.running.delete(cardId);

    const card = getCard(this.database, cardId);

    if (result === null) {
      updateCard(this.database, cardId, { status: 'blocked' });
      this.#halt(boardId, {
        reason: 'launch-error',
        cardId,
        cardTitle: card.title,
        detail: 'The session could not be supervised.',
        at: Date.now(),
      });
      this.#publish(boardId);
      return;
    }

    this.events.onRunFinished?.(boardId, cardId, result);

    if (result.outcome === 'cancelled') {
      updateCard(this.database, cardId, { status: 'abandoned' });
      this.#halt(boardId, {
        reason: 'cancelled',
        cardId,
        cardTitle: card.title,
        detail: 'The run was cancelled.',
        at: Date.now(),
      });
      this.#publish(boardId);
      return;
    }

    if (result.outcome === 'failed') {
      updateCard(this.database, cardId, { status: 'blocked' });
      this.#halt(boardId, {
        reason: 'failure',
        cardId,
        cardTitle: card.title,
        detail: `The session exited with code ${String(result.exitCode)}.`,
        at: Date.now(),
      });
      this.#publish(boardId);
      return;
    }

    // Completed. The card moves to the review column and waits: a finished run
    // is not a reviewed one, and later cards may build on this.
    this.#moveToReview(boardId, cardId);
    updateCard(this.database, cardId, { status: 'awaiting-review' });

    this.#halt(boardId, {
      reason: 'awaiting-review',
      cardId,
      cardTitle: card.title,
      detail: 'The run finished and is waiting to be reviewed.',
      at: Date.now(),
    });

    this.#publish(boardId);
  }

  #moveToReview(boardId: string, cardId: string): void {
    const review = this.database.db
      .select()
      .from(columns)
      .where(eq(columns.boardId, boardId))
      .all()
      .find((column) => column.isReviewGate);

    if (review === undefined) return;

    this.database.db
      .update(cards)
      .set({ columnId: review.id, updatedAt: Date.now() })
      .where(eq(cards.id, cardId))
      .run();
  }

  cancel(boardId: string, cardId: string): boolean {
    const running = this.#stateFor(boardId).running.get(cardId);
    if (running === undefined) return false;

    running.cancel();
    return true;
  }

  async shutdown(): Promise<void> {
    await this.#registry.cancelAll();
  }
}
