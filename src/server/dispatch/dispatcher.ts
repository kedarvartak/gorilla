import { eq } from 'drizzle-orm';

import { getCard, updateCard } from '../api/cards.js';
import { canonicaliseCwd } from '../ingest/binding.js';
import { dispatchableCards } from '../cards/eligibility.js';
import { parseGuardrails } from '../cards/guardrails.js';
import type { DatabaseHandle } from '../db/client.js';
import { boards, cards, columns, invariants, runs } from '../db/schema.js';
import type { PendingBindings } from '../binding/pending.js';
import { describeVerify, runVerify, type VerifyResult } from '../verify/run.js';
import { outstandingSurprises } from '../ledger/outstanding.js';
import { storedEntriesFor } from '../ledger/store.js';
import { assessStall, DEFAULT_STALL, progressOf, type StallThresholds } from './stall.js';
import { WorktreeManager } from '../worktree/manager.js';
import { commitWorkspace } from '../worktree/commit.js';
import {
  launch,
  LaunchRegistry,
  type LaunchResult,
  type RunningLaunch,
} from '../launcher/launcher.js';
import { accumulateCost, CostMeter } from '../launcher/cost.js';
import { describeSpend, overBudget, spentSince, startOfDay } from './budget.js';

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
  | 'no-workspace'
  // The run stopped getting anywhere: refused calls, or silence.
  | 'stalled'
  // A finished card has surprises nobody has judged, so the queue stopped
  // rather than starting the next card on top of them.
  | 'unacknowledged-surprises'
  // The run passed the card's token ceiling and was stopped (T26).
  | 'over-budget'
  // The board has spent its budget for the day, so the queue stopped rather
  // than starting another card (T27).
  | 'day-budget-spent';

export interface HaltState {
  readonly reason: HaltReason;
  readonly cardId: string;
  readonly cardTitle: string;
  readonly detail: string;
  readonly at: number;
}

export interface BoardDispatchState {
  readonly mode: DispatchMode;
  readonly policy: QueuePolicy;
  readonly concurrency: number;
  /** Cards that finished and are waiting to be looked at. */
  readonly completed: readonly string[];
  readonly running: readonly string[];
  readonly halted: HaltState | null;
}

export interface DispatcherEvents {
  readonly onStateChange?: (boardId: string, state: BoardDispatchState) => void;
  readonly onRunStarted?: (boardId: string, cardId: string, sessionId: string | null) => void;
  readonly onRunFinished?: (boardId: string, cardId: string, result: LaunchResult) => void;
  readonly onVerified?: (boardId: string, cardId: string, result: VerifyResult) => void;
  /** Files the board committed on the card's behalf when its run ended. */
  readonly onCommitted?: (boardId: string, cardId: string, files: number) => void;
  /**
   * The queue stopped. Fired once per halt, on the halt that caused it: later
   * failures are consequences, and a notifier that repeated them would train
   * the operator to ignore the one that mattered.
   */
  readonly onHalted?: (boardId: string, halt: HaltState) => void;
}

interface BoardState {
  mode: DispatchMode;
  policy: QueuePolicy;
  concurrency: number;
  running: Map<string, RunningLaunch>;
  completed: Set<string>;
  /**
   * Cards that finished under this dispatcher and may still have something
   * outstanding. Distinct from `completed`, which `resume` clears: this set is
   * what makes the gate a gate. If clearing the halt also emptied it, an
   * operator could dismiss the stop without reading anything, and a control
   * that is dismissed by the act of noticing it is a notification.
   */
  awaitingAck: Set<string>;
  halted: HaltState | null;
}

export const DEFAULT_CONCURRENCY = 1;

/**
 * How the queue treats a completed run.
 *
 * `review` stops after every completion, which is right while the operator is
 * present: a finished run is not a reviewed one, and the next card might build
 * on it.
 *
 * `unattended` keeps going and collects completions for the morning. It is
 * only safe because U2 gives each card its own worktree - a later card cannot
 * see an earlier card's unmerged work unless it declared a dependency, in
 * which case the graph already sequences them (doc 18).
 *
 * Under `unattended` the queue still halts on failure, on a run that achieved
 * nothing, and on a failed verify. Those are the states where continuing would
 * pile work on a broken foundation.
 */
export type QueuePolicy = 'review' | 'unattended';

/**
 * A dispatched agent decides for itself and never stops to ask (doc 18).
 *
 * There was briefly a `copilot` alternative that halted the card the moment the
 * agent raised `PermissionRequest` or `Notification`. It is gone, deliberately:
 * the point of an overnight run is that nobody is awake to answer, and a queue
 * that stops on the first question has spent the night doing one card.
 *
 * That is not "no supervision". Questions are still recorded and surface in the
 * brief in the morning, and stall detection still halts a run either way -
 * which is what makes this safe rather than merely convenient. An agent that
 * asks and then waits produces no events, and silence is one of the two shapes
 * `assessStall` looks for.
 */

export class Dispatcher {
  readonly #boards = new Map<string, BoardState>();
  readonly #registry = new LaunchRegistry();
  readonly #lastVerify = new Map<string, VerifyResult>();
  readonly #worktrees = new Map<string, WorktreeManager>();
  readonly #pumping = new Set<string>();
  /**
   * Set by shutdown, so work already in flight stops touching the database.
   *
   * One flag, deliberately. Resolving the P4 merge briefly left two - `#closed`
   * and `#stopped` - and shutdown set only one, so every guard written against
   * the other silently never fired. CI found it as an unhandled rejection
   * against a closed connection; two names for one condition is how that
   * happens.
   */
  #stopped = false;
  #executable: string | undefined;

  /** Loosened in tests that need a stall detected without waiting minutes. */
  stallThresholds: StallThresholds = DEFAULT_STALL;

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
      policy: 'review',
      concurrency: DEFAULT_CONCURRENCY,
      running: new Map(),
      completed: new Set(),
      awaitingAck: new Set(),
      halted: null,
    };
    this.#boards.set(boardId, created);
    return created;
  }

  state(boardId: string): BoardDispatchState {
    const state = this.#stateFor(boardId);
    return {
      mode: state.mode,
      policy: state.policy,
      concurrency: state.concurrency,
      running: [...state.running.keys()],
      completed: [...state.completed],
      halted: state.halted,
    };
  }

  #publish(boardId: string): void {
    this.events.onStateChange?.(boardId, this.state(boardId));
  }

  setMode(boardId: string, mode: DispatchMode): BoardDispatchState {
    this.#stateFor(boardId).mode = mode;
    this.#publish(boardId);

    if (mode === 'automatic') void this.pump(boardId).catch(() => undefined);
    return this.state(boardId);
  }

  /**
   * Switching to `unattended` also raises nothing on its own: concurrency is a
   * separate decision, because how many agents a machine can host is not the
   * same question as whether the operator is awake.
   */
  setPolicy(boardId: string, policy: QueuePolicy): BoardDispatchState {
    this.#stateFor(boardId).policy = policy;
    this.#publish(boardId);

    if (policy === 'unattended') void this.pump(boardId).catch(() => undefined);
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
   *
   * It does not clear `awaitingAck`. Resuming past an unacknowledged surprise
   * re-halts on the next pump, because the gate is retired by judging the
   * surprise rather than by pressing resume - otherwise the only cost of
   * skipping the review would be one extra click.
   */
  resume(boardId: string): BoardDispatchState {
    this.#stateFor(boardId).halted = null;
    this.#stateFor(boardId).completed.clear();
    this.#publish(boardId);

    if (this.#stateFor(boardId).mode === 'automatic')
      void this.pump(boardId).catch(() => undefined);
    return this.state(boardId);
  }

  #halt(boardId: string, halt: HaltState): void {
    const state = this.#stateFor(boardId);
    // The first halt is the one that matters; later failures are consequences.
    if (state.halted === null) {
      state.halted = halt;
      this.#publish(boardId);

      // After the state is set and published. A notifier that threw before the
      // halt was recorded would leave the queue stopped and the board unable
      // to say why, which is worse than no notification at all.
      try {
        this.events.onHalted?.(boardId, halt);
      } catch {
        // Fail open: telling the operator is not worth breaking the gate for.
      }
    }
  }

  /**
   * The queue gate (doc 08, P4).
   *
   * Layer one showed the operator what was surprising and layer three declined
   * to merge it. Neither costs anything at 3am, when the operator who would
   * rather not review simply does not look. This one does: the queue stops, so
   * skipping the review costs progress instead of costing nothing.
   *
   * Halts and returns true when a finished card still has something nobody has
   * judged. Cards whose surprises have all been acknowledged drop out of the
   * set as they are checked, so the gate opens by itself once the reading is
   * done rather than needing a second gesture.
   *
   * Like the merge gate, this is the board declining to start work, not a lock:
   * anyone can run `claude` in the worktree by hand. Saying otherwise would be
   * asserting a guarantee this cannot keep (R10).
   */
  async #gateOnSurprises(boardId: string): Promise<boolean> {
    const state = this.#stateFor(boardId);
    if (state.awaitingAck.size === 0) return false;

    const board = this.database.db.select().from(boards).where(eq(boards.id, boardId)).get();

    for (const cardId of [...state.awaitingAck]) {
      // Re-checked inside the loop, not only around it. `outstandingSurprises`
      // reads git, so shutdown can land between two iterations, and the next
      // read would be against a closed connection.
      if (this.#stopped) return true;

      const surprises = await outstandingSurprises({
        database: this.database,
        cardId,
        cwd: board === undefined ? undefined : this.#workspacePath(board.cwd, cardId),
      });

      if (surprises.length === 0) {
        state.awaitingAck.delete(cardId);
        continue;
      }

      const card = getCard(this.database, cardId);
      const counted =
        surprises.length === 1 ? '1 surprise' : `${String(surprises.length)} surprises`;

      // The count, not the list: the halt is a stop sign, and the card's brief
      // is where the surprises are already presented in full.
      this.#halt(boardId, {
        reason: 'unacknowledged-surprises',
        cardId,
        cardTitle: card.title,
        detail:
          `"${card.title}" finished with ${counted} nobody has judged, so the queue stopped ` +
          'rather than starting the next card on top of them. Judge them on the card, then resume.',
        at: Date.now(),
      });
      return true;
    }

    return false;
  }

  /** Starts eligible cards up to the concurrency limit. */
  async pump(boardId: string): Promise<string[]> {
    const state = this.#stateFor(boardId);
    if (this.#stopped) return [];
    if (state.halted !== null) return [];
    if (state.mode !== 'automatic') return [];

    // Guards against two pumps interleaving and starting the same card twice
    // when several runs finish at once.
    if (this.#pumping.has(boardId)) return [];
    this.#pumping.add(boardId);

    const started: string[] = [];

    while (state.running.size < state.concurrency && state.halted === null) {
      // The queue gate (P4). Asked before every start, not once per pump: a
      // card that finishes while this loop is running is exactly the case the
      // gate exists for.
      if (this.#stopped) break;
      if (await this.#gateOnSurprises(boardId)) break;
      // The gate reads git, so the dispatcher can be shut down underneath it.
      // Starting a card after that would touch a database nobody owns any more.
      if (this.#stopped) break;

      const next = dispatchableCards(this.database.db, boardId)[0];
      if (next === undefined) break;

      // Asked before each start rather than once per pump, for the same reason
      // the surprise gate is: the card that tips the board over its budget is
      // usually one this loop just started.
      if (this.#gateOnDayBudget(boardId, next.id, next.title)) break;

      const launched = await this.dispatchIsolated(boardId, next.id);
      if (launched === null) break;
      started.push(next.id);
    }

    this.#pumping.delete(boardId);
    return started;
  }

  /**
   * Stops the queue once the day's budget is gone (T27).
   *
   * The per-card ceiling stops one runaway run. It does nothing about a queue
   * of fifty reasonable cards, which is the shape an overnight batch actually
   * takes: nothing individually alarming, and a bill in the morning.
   *
   * Nothing in flight is touched. A run that is already spending has work on
   * its branch worth more than the tokens it will spend finishing, and killing
   * it would leave the board paying for an unfinished job.
   */
  #gateOnDayBudget(boardId: string, cardId: string, cardTitle: string): boolean {
    const board = this.database.db.select().from(boards).where(eq(boards.id, boardId)).get();
    if (board === undefined || board.dailyTokenBudget === null) return false;

    const spend = spentSince(this.database.sqlite, boardId, startOfDay(Date.now()));
    if (!overBudget(spend, board.dailyTokenBudget)) return false;

    this.#halt(boardId, {
      reason: 'day-budget-spent',
      cardId,
      cardTitle,
      detail: `The board has spent ${describeSpend(spend, board.dailyTokenBudget)} Nothing new will start until the budget is raised or the day turns.`,
      at: Date.now(),
    });
    this.#publish(boardId);
    return true;
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

  /**
   * The operator's verdicts on this card's ledger entries, split into what a
   * launched run should treat as established and what it should treat as
   * settled-against. A rejected entry is kept rather than deleted (doc 12), so
   * this reads the same table the brief and the merge gate already read.
   */
  #judgementsFor(cardId: string): { accepted: string[]; rejected: string[] } {
    const entries = storedEntriesFor(this.database, cardId);
    const accepted = entries
      .filter((entry) => entry.operatorStatus === 'accepted')
      .map((entry) => entry.statement);
    const rejected = entries
      .filter((entry) => entry.operatorStatus === 'rejected')
      .map((entry) => entry.statement);
    return { accepted, rejected };
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

    // The directory the child will actually run in, which since U2 is this
    // card's own worktree. The expectation must be filed under that and not
    // under the board's checkout: the session reports its own cwd, so a
    // board-keyed expectation is looked up under a path nothing ever sends.
    // Canonicalised on both sides: the hook path canonicalises the cwd a session
    // reports, and a key that differs only by a resolved symlink never matches.
    const workspace = canonicaliseCwd(this.#workspacePath(board.cwd, cardId));

    updateCard(this.database, cardId, { status: 'running' });

    // What the operator has already judged on this card, fed back so a run
    // acts on a correction instead of re-arriving at a claim already settled
    // (P5). Cards with no judgements yet get neither section.
    const { accepted, rejected } = this.#judgementsFor(cardId);

    // Registered before the child starts. SessionStart fires before the
    // launcher can read the session id from the stream, so without this the
    // hook path infers a provisional card and the run is attributed to a
    // phantom instead of this card (doc 17).
    this.pending.expect(workspace, cardId);

    // Counts what the stream has reported so far. It reads low by
    // construction - see CostMeter - so the ceiling stops a run just after it
    // crosses rather than just before, which beats killing runs that had not
    // actually overspent.
    const meter = new CostMeter();

    const running = this.#registry.track(
      launch({
        cwd: workspace,
        title: card.title,
        body: card.body,
        guardrails: parseGuardrails(card.guardrails),
        goalCondition: card.goalCondition,
        branch: this.#worktreesFor(board.cwd).workspaceFor(cardId)?.branch ?? null,
        invariants: this.database.db
          .select({ statement: invariants.statement })
          .from(invariants)
          .where(eq(invariants.boardId, boardId))
          .all()
          .map((row) => row.statement),
        agentModel: card.agentModel,
        agentEffort: card.agentEffort,
        permissionMode: card.permissionMode,
        cardId,
        ...(accepted.length === 0 ? {} : { acceptedEntries: accepted }),
        ...(rejected.length === 0 ? {} : { rejectedEntries: rejected }),
        ...(this.#executable === undefined ? {} : { executable: this.#executable }),
        onEvent: (event) => {
          meter.feed(event);
          if (!meter.exceeds(card.tokenCeiling)) return;

          // Recorded before the cancel, so the settle path can tell a stop for
          // spending from a stop by the operator.
          if (this.#overBudget.has(cardId)) return;
          this.#overBudget.set(cardId, meter.tokens);
          this.#stateFor(boardId).running.get(cardId)?.cancel();
        },
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
      // Caught, not just voided. `#settle` is fire-and-forget and does real
      // asynchronous work - committing, verifying - so a board that shuts down
      // while one is in flight would otherwise raise an unhandled rejection,
      // which Node turns into a process exit. The board must not die because a
      // run happened to finish at the wrong moment.
      (result) => void this.#settle(boardId, cardId, result).catch(() => undefined),
      () => void this.#settle(boardId, cardId, null).catch(() => undefined),
    );

    return running;
  }

  /**
   * Writes what the run cost onto its row (T29).
   *
   * Keyed on the session id because that is the only identifier the run row
   * and the launcher agree on. A run whose stream never yielded a session id
   * cannot be found, and is left unrecorded rather than guessed at: attaching
   * one run's bill to another card is worse than recording no bill at all.
   */
  /**
   * Cards stopped for spending, and what they had spent when stopped.
   *
   * Kept here because the launcher reports a budget stop and an operator's
   * cancel identically - both are SIGTERM, both come back as `cancelled`. A
   * board that called the first one "cancelled" would tell the operator they
   * did something they did not do.
   */
  readonly #overBudget = new Map<string, number>();

  #recordCost(result: LaunchResult): void {
    if (result.sessionId === null) return;

    const cost = accumulateCost(result.events);
    if (cost.source === 'none') return;

    this.database.db
      .update(runs)
      .set({
        inputTokens: cost.inputTokens,
        outputTokens: cost.outputTokens,
        cacheReadTokens: cost.cacheReadTokens,
        cacheCreationTokens: cost.cacheCreationTokens,
        costUsd: cost.costUsd,
        turns: cost.turns,
        costSource: cost.source,
      })
      .where(eq(runs.sessionId, result.sessionId))
      .run();
  }

  async #settle(boardId: string, cardId: string, result: LaunchResult | null): Promise<void> {
    // Nothing to settle into. Shutdown closes the database, and a settle that
    // began before it would otherwise query a closed connection.
    if (this.#stopped) return;

    const state = this.#stateFor(boardId);
    state.running.delete(cardId);

    const board = this.database.db.select().from(boards).where(eq(boards.id, boardId)).get();
    if (board !== undefined) {
      this.pending.release(canonicaliseCwd(this.#workspacePath(board.cwd, cardId)), cardId);
    }

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

    this.#recordCost(result);
    this.events.onRunFinished?.(boardId, cardId, result);

    if (result.outcome === 'cancelled') {
      const spent = this.#overBudget.get(cardId);
      this.#overBudget.delete(cardId);

      // A stop for spending is not an abandonment. The card has work on its
      // branch and a reason it stopped, so it goes to blocked and says what it
      // spent - naming the ceiling it crossed, because an operator who cannot
      // see the limit cannot tell an overspend from a crash.
      if (spent !== undefined) {
        updateCard(this.database, cardId, { status: 'blocked' });
        this.#halt(boardId, {
          reason: 'over-budget',
          cardId,
          cardTitle: card.title,
          detail: `The run passed its ceiling of ${String(card.tokenCeiling ?? 0)} tokens, at ${String(spent)}, and was stopped.`,
          at: Date.now(),
        });
        this.#publish(boardId);
        return;
      }

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

    // Before verify, so what the board checks is what the branch holds. A run
    // that finished with work still uncommitted has produced a branch the
    // reviewer will refuse and an operator who reasonably believed it was done
    // - which happened twice before anything told the agent it had a branch.
    await this.#commitWork(boardId, cardId, card.title);
    if (this.#stopped) return;

    // The board runs the card's verify command itself. Until now `verify` was
    // displayed as a hard guardrail and never executed, which is the failure
    // R10 exists to prevent (doc 18, U1).
    const verify = await this.#verify(boardId, cardId);

    state.completed.add(cardId);
    state.awaitingAck.add(cardId);

    if (verify?.status === 'failed' || verify?.status === 'errored') {
      this.#halt(boardId, {
        reason: 'verify-failed',
        cardId,
        cardTitle: card.title,
        detail: describeVerify(verify),
        at: Date.now(),
      });
      this.#publish(boardId);
      return;
    }

    if (state.policy === 'review') {
      this.#halt(boardId, {
        reason: 'awaiting-review',
        cardId,
        cardTitle: card.title,
        detail:
          verify === null || verify.status === 'skipped'
            ? 'The run finished and is waiting to be reviewed.'
            : describeVerify(verify),
        at: Date.now(),
      });
      this.#publish(boardId);
      return;
    }

    // Unattended: the completion is recorded and the queue moves on. Stopping
    // here would mean waking to one finished task and a queue that never
    // moved, which is the entire point of the mode.
    this.#publish(boardId);
    void this.pump(boardId).catch(() => undefined);
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
  /**
   * Watches a running card, from the hook path.
   *
   * Called for every event, so it must stay cheap: two indexed aggregates and a
   * comparison. It exists because the checks in `#settle` only run when a session
   * finishes, and the failure worth catching is the one that never finishes.
   *
   * The event's name is not read. Progress is judged from the run's own totals,
   * so no single event needs to mean anything on its own.
   */
  observe(runId: string, now = Date.now()): void {
    const bound = this.#runningCardFor(runId);
    if (bound === null) return;

    const { boardId, cardId } = bound;

    const progress = progressOf(this.database.sqlite, runId);
    if (progress === null) return;

    const verdict = assessStall(progress, now, this.stallThresholds);
    if (verdict.stalled) {
      this.#stop(boardId, cardId, 'stalled', verdict.detail ?? 'The run stopped making progress.');
    }
  }

  /** The board and card of a run this dispatcher is currently supervising. */
  #runningCardFor(runId: string): { boardId: string; cardId: string } | null {
    const run = this.database.db.select().from(runs).where(eq(runs.id, runId)).get();
    if (run?.cardId === null || run?.cardId === undefined) return null;

    for (const [boardId, state] of this.#boards) {
      if (state.running.has(run.cardId)) return { boardId, cardId: run.cardId };
    }
    return null;
  }

  /**
   * Cancels a run and halts, for a reason the run itself will not report.
   *
   * The cancel is what stops the money. The halt is what stops the queue piling
   * later cards on top of a card that never worked.
   */
  #stop(boardId: string, cardId: string, reason: HaltReason, detail: string): void {
    const card = getCard(this.database, cardId);

    this.cancel(boardId, cardId);
    updateCard(this.database, cardId, { status: 'blocked' });

    this.#halt(boardId, { reason, cardId, cardTitle: card.title, detail, at: Date.now() });
    this.#publish(boardId);
  }

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

  /**
   * Commits whatever the run left uncommitted, onto the card's own branch.
   *
   * The floor under the instruction in the launch context, not a replacement
   * for it: an agent that commits as it goes writes better messages than this
   * can. This only ensures that "the card finished" and "the work is on the
   * branch" cannot come apart.
   */
  async #commitWork(boardId: string, cardId: string, cardTitle: string): Promise<void> {
    const board = this.database.db.select().from(boards).where(eq(boards.id, boardId)).get();
    if (board === undefined) return;

    const workspace = this.#worktreesFor(board.cwd).workspaceFor(cardId);
    // No worktree means the card ran in the board's own checkout, where
    // committing on the operator's behalf would sweep up their work too.
    if (workspace === undefined) return;

    const result = await commitWorkspace({ cwd: workspace.path, cardId, cardTitle });
    if (result.committed) this.events.onCommitted?.(boardId, cardId, result.files);
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
    this.#stopped = true;
    await this.#registry.cancelAll();
  }
}
