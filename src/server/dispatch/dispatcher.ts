import { eq } from 'drizzle-orm';

import { getCard, updateCard } from '../api/cards.js';
import { dispatchableCards } from '../cards/eligibility.js';
import { parseGuardrails } from '../cards/guardrails.js';
import type { DatabaseHandle } from '../db/client.js';
import { boards, cards, columns, runs } from '../db/schema.js';
import type { PendingBindings } from '../binding/pending.js';
import { describeVerify, runVerify, type VerifyResult } from '../verify/run.js';
import { WorktreeManager } from '../worktree/manager.js';
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

export type HaltReason =
  | 'failure'
  | 'cancelled'
  | 'awaiting-review'
  | 'no-goal'
  | 'launch-error'
  | 'no-effect'
  // The board ran the card's verify command and it did not pass.
  | 'verify-failed'
  // The card could not be given an isolated worktree to work in.
  | 'no-workspace';

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
  readonly onVerified?: (boardId: string, cardId: string, result: VerifyResult) => void;
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
  readonly #lastVerify = new Map<string, VerifyResult>();
  readonly #worktrees = new Map<string, WorktreeManager>();
  #executable: string | undefined;

  /** Overridden in tests; otherwise resolved from the card's worktree. */
  workspaceFor: ((cardId: string) => string | undefined) | undefined;

  /** Worktree isolation. Off only where a board directory is not a repository. */
  isolate = true;

  constructor(
    private readonly database: DatabaseHandle,
    private readonly pending: PendingBindings,
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

    if (mode === 'automatic') void this.pump(boardId);
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

    if (this.#stateFor(boardId).mode === 'automatic') void this.pump(boardId);
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
  async pump(boardId: string): Promise<string[]> {
    const state = this.#stateFor(boardId);
    if (state.halted !== null) return [];
    if (state.mode !== 'automatic') return [];

    const started: string[] = [];

    while (state.running.size < state.concurrency && state.halted === null) {
      const next = dispatchableCards(this.database.db, boardId)[0];
      if (next === undefined) break;

      const launched = await this.dispatchIsolated(boardId, next.id);
      if (launched === null) break;
      started.push(next.id);
    }

    return started;
  }

  /**
   * Dispatches one card. Returns null when it could not start, having recorded
   * why - a card that silently fails to launch is worse than one that fails.
   */
  #worktreesFor(boardCwd: string): WorktreeManager {
    const existing = this.#worktrees.get(boardCwd);
    if (existing !== undefined) return existing;

    const created = new WorktreeManager(boardCwd);
    this.#worktrees.set(boardCwd, created);
    return created;
  }

  worktreesFor(boardCwd: string): WorktreeManager {
    return this.#worktreesFor(boardCwd);
  }

  /** Where a card's work lives: its worktree, or the board directory. */
  #workspacePath(boardCwd: string, cardId: string): string {
    return this.workspaceFor?.(cardId) ?? this.#worktreesFor(boardCwd).pathFor(cardId) ?? boardCwd;
  }

  async dispatchIsolated(boardId: string, cardId: string): Promise<RunningLaunch | null> {
    const board = this.database.db.select().from(boards).where(eq(boards.id, boardId)).get();
    if (board === undefined) return null;

    if (this.isolate && this.workspaceFor === undefined) {
      const card = getCard(this.database, cardId);
      const base = this.#baseRefFor(board.cwd, cardId);

      const workspace = await this.#worktreesFor(board.cwd).create(
        cardId,
        card.title,
        base ?? undefined,
      );

      if (!workspace.ok) {
        // Refusing beats running several agents in one checkout, where they
        // overwrite each other and the damage is discovered at merge time.
        this.#halt(boardId, {
          reason: 'no-workspace',
          cardId,
          cardTitle: card.title,
          detail: workspace.reason,
          at: Date.now(),
        });
        return null;
      }
    }

    return this.dispatch(boardId, cardId);
  }

  /**
   * A dependent card branches from its dependency's branch when that work is
   * not merged yet, so declared work composes and undeclared work stays
   * isolated (doc 18).
   */
  #baseRefFor(boardCwd: string, cardId: string): string | null {
    const dependencies = this.database.sqlite
      .prepare('SELECT depends_on_card_id AS id FROM card_dependencies WHERE card_id = ?')
      .all(cardId) as { id: string }[];

    const manager = this.#worktreesFor(boardCwd);

    for (const dependency of dependencies) {
      const workspace = manager.workspaceFor(dependency.id);
      if (workspace !== undefined) return workspace.branch;
    }

    return null;
  }

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

    // Registered before the child starts. SessionStart fires before the
    // launcher can read the session id from the stream, so without this the
    // hook path infers a provisional card and the run is attributed to a
    // phantom instead of this card (doc 17).
    this.pending.expect(board.cwd, cardId);

    const running = this.#registry.track(
      launch({
        cwd: this.#workspacePath(board.cwd, cardId),
        title: card.title,
        body: card.body,
        guardrails: parseGuardrails(card.guardrails),
        goalCondition: card.goalCondition,
        agentModel: card.agentModel,
        agentEffort: card.agentEffort,
        permissionMode: card.permissionMode,
        cardId,
        ...(this.#executable === undefined ? {} : { executable: this.#executable }),
        onSessionId: (sessionId) => {
          // Belt and braces: if the run already exists and is unbound, or was
          // bound elsewhere, correct it now that the session id is known.
          this.database.db
            .update(runs)
            .set({ cardId, mode: 'launched' })
            .where(eq(runs.sessionId, sessionId))
            .run();

          this.events.onRunStarted?.(boardId, cardId, sessionId);
        },
      }),
    );

    state.running.set(cardId, running);
    this.#publish(boardId);

    void running.result.then(
      (result) => void this.#settle(boardId, cardId, result),
      () => void this.#settle(boardId, cardId, null),
    );

    return running;
  }

  async #settle(boardId: string, cardId: string, result: LaunchResult | null): Promise<void> {
    const state = this.#stateFor(boardId);
    state.running.delete(cardId);

    const board = this.database.db.select().from(boards).where(eq(boards.id, boardId)).get();
    if (board !== undefined) this.pending.release(board.cwd, cardId);

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

    // A run can exit 0 having been refused every tool call - the agent tries,
    // is denied, and gives up. Reporting that as an ordinary completion is a
    // false success, which is doc 01's fourth failure mode (doc 17).
    const effect = this.#effectOf(cardId);

    if (effect.achievedNothing) {
      this.#halt(boardId, {
        reason: 'no-effect',
        cardId,
        cardTitle: card.title,
        detail: `The run finished without completing a single tool call. ${effect.unresolved} attempt(s) had no outcome, which usually means they were denied.`,
        at: Date.now(),
      });
      this.#publish(boardId);
      return;
    }

    // The board runs the card's verify command itself. Until now `verify` was
    // displayed as a hard guardrail and never executed, which is the failure
    // R10 exists to prevent (doc 18, U1).
    const verify = await this.#verify(boardId, cardId);

    this.#halt(boardId, {
      reason:
        verify?.status === 'failed' || verify?.status === 'errored'
          ? 'verify-failed'
          : 'awaiting-review',
      cardId,
      cardTitle: card.title,
      detail:
        verify === null || verify.status === 'skipped'
          ? 'The run finished and is waiting to be reviewed.'
          : describeVerify(verify),
      at: Date.now(),
    });

    this.#publish(boardId);
  }

  /** Runs the card's verify command where the work happened. */
  async #verify(boardId: string, cardId: string): Promise<VerifyResult | null> {
    const card = getCard(this.database, cardId);
    const guardrails = parseGuardrails(card.guardrails);
    if (guardrails.verify === null) return null;

    const board = this.database.db.select().from(boards).where(eq(boards.id, boardId)).get();
    if (board === undefined) return null;

    // The card's worktree once U2 lands; the board directory until then.
    const cwd = this.#workspacePath(board.cwd, cardId);

    const result = await runVerify({ command: guardrails.verify, cwd });
    this.#lastVerify.set(cardId, result);
    this.events.onVerified?.(boardId, cardId, result);

    return result;
  }

  /** The most recent verify result for a card, for the interface and the ledger. */
  verifyResultFor(cardId: string): VerifyResult | undefined {
    return this.#lastVerify.get(cardId);
  }

  /** Whether the card's runs actually did anything. */
  #effectOf(cardId: string): { achievedNothing: boolean; unresolved: number } {
    const row = this.database.sqlite
      .prepare(
        `SELECT
           SUM(CASE WHEN event_name = 'PreToolUse' THEN 1 ELSE 0 END) AS intents,
           SUM(CASE WHEN event_name IN ('PostToolUse', 'PostToolUseFailure') THEN 1 ELSE 0 END) AS outcomes
         FROM events WHERE run_id IN (SELECT id FROM runs WHERE card_id = ?)`,
      )
      .get(cardId) as { intents: number | null; outcomes: number | null };

    const intents = row.intents ?? 0;
    const outcomes = row.outcomes ?? 0;

    return { achievedNothing: intents > 0 && outcomes === 0, unresolved: intents - outcomes };
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
