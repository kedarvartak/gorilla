/**
 * Bindings the board is expecting.
 *
 * When the dispatcher launches a card it knows which card the session belongs
 * to, but it does not yet know the session id: `SessionStart` fires before the
 * launcher has read `system/init` from the stream. Without somewhere to record
 * that expectation, the SessionStart handler sees an unbound session and does
 * the reasonable thing for a terminal session - it infers a provisional card,
 * and the run is attributed to a phantom instead of the card that launched it.
 *
 * That failure is invisible in isolation: launched mode and inferred binding
 * are each correct on their own. It only appears end to end, which is what the
 * Phase 1 verification found (doc 17).
 *
 * Keyed by the **launched session's own working directory**, which since U2 is
 * the card's isolated worktree rather than the board's checkout. That is what
 * makes the key unambiguous at any concurrency: one card, one worktree, one
 * expectation. Keying on the board directory - as this did originally - was
 * both ambiguous when two cards ran at once and, once worktrees became real,
 * simply wrong: the expectation was filed under a path no session ever reports.
 *
 * A directory with more than one live expectation can only arise with isolation
 * off, and there `claim` refuses to answer. Attributing a session to the wrong
 * card is silent and permanent; leaving it unbound produces a provisional card,
 * which is visible and correctable. Doc 05 already chose that trade: an event
 * with nowhere to go is the blind spot, and a provisional card is the answer.
 */

export interface PendingBinding {
  readonly cardId: string;
  readonly at: number;
}

/** How long a pending launch stays claimable. A session that never started should not capture a later one. */
export const PENDING_TTL_MS = 120_000;

export class PendingBindings {
  readonly #byCwd = new Map<string, PendingBinding[]>();

  expect(cwd: string, cardId: string, now = Date.now()): void {
    const queue = this.#byCwd.get(cwd) ?? [];
    queue.push({ cardId, at: now });
    this.#byCwd.set(cwd, queue);
  }

  /**
   * Takes the one unexpired expectation for a directory.
   *
   * Refuses when there is more than one. With a worktree per card that never
   * happens; without isolation it means two sessions are starting in the same
   * place and nothing in the payload distinguishes them. Guessing would attach
   * a night's work to the wrong card and say nothing about it.
   */
  claim(cwd: string, now = Date.now()): string | null {
    const queue = this.#byCwd.get(cwd);
    if (queue === undefined) return null;

    // Expired entries are dropped first: a launch that never produced a session
    // must not capture an unrelated one later, nor make a directory look
    // ambiguous for ever.
    const live = queue.filter((pending) => now - pending.at <= PENDING_TTL_MS);
    this.#byCwd.set(cwd, live);

    if (live.length !== 1) return null;

    const only = live[0];
    if (only === undefined) return null;

    this.#byCwd.set(cwd, []);
    return only.cardId;
  }

  /** Drops an expectation that has been satisfied another way. */
  release(cwd: string, cardId: string): void {
    const queue = this.#byCwd.get(cwd);
    if (queue === undefined) return;
    this.#byCwd.set(
      cwd,
      queue.filter((pending) => pending.cardId !== cardId),
    );
  }

  pendingFor(cwd: string): readonly PendingBinding[] {
    return this.#byCwd.get(cwd) ?? [];
  }

  /** Live expectations for a directory. More than one means claims are refused. */
  liveCount(cwd: string, now = Date.now()): number {
    return (this.#byCwd.get(cwd) ?? []).filter((pending) => now - pending.at <= PENDING_TTL_MS)
      .length;
  }
}
