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
 * Keyed by working directory and consumed in order, because dispatch is serial
 * by default and the board launched them.
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

  /** Takes the oldest unexpired expectation for a directory, if any. */
  claim(cwd: string, now = Date.now()): string | null {
    const queue = this.#byCwd.get(cwd);
    if (queue === undefined) return null;

    while (queue.length > 0) {
      const next = queue.shift();
      if (next === undefined) break;
      if (now - next.at <= PENDING_TTL_MS) return next.cardId;
      // Expired: the launch never produced a session, so drop it rather than
      // letting it capture an unrelated one later.
    }

    return null;
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
}
