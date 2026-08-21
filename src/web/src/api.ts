/**
 * Board data and the live connection.
 *
 * No state library: the server is the source of truth and SSE is the change
 * feed, so a store would be a second copy to keep correct. React state plus a
 * refetch on each frame is enough at this size and cannot drift.
 */

export interface GuardrailDetail {
  readonly kind: string;
  readonly text: string;
  readonly enforcement: 'hard' | 'advisory';
  readonly because: string;
}

export interface Card {
  readonly id: string;
  readonly boardId: string;
  readonly columnId: string;
  readonly title: string;
  readonly body: string;
  readonly position: number;
  readonly status:
    'idle' | 'queued' | 'running' | 'awaiting-review' | 'blocked' | 'done' | 'abandoned';
  readonly goalCondition: string | null;
  /** Reaches `claude --model` for this card's run. Null means the board default. */
  readonly agentModel: string | null;
  /** Reorders the dispatch queue within a Ready column; not decoration. */
  readonly priority: 'high' | 'normal' | 'low';
  /** Reaches `claude --effort`. */
  readonly agentEffort: string | null;
  /** Tokens a run may spend before the board stops it. Null means no ceiling. */
  readonly tokenCeiling: number | null;
  /** Used only for windows that escalate - compaction, and manual re-extraction. */
  readonly synthesisModel: string | null;
  readonly lastSeenAt: number | null;
  /**
   * Set only when the board merged this card's branch. `done` on its own means
   * finished some other way, which is a different thing to tell the operator.
   */
  readonly mergedAt: number | null;
  readonly mergedInto: string | null;
  readonly mergedBranch: string | null;
  readonly updatedAt: number;
  readonly guardrailDetail: readonly GuardrailDetail[];
  /**
   * Position in the order the remaining work should be done, 1-based. Null once
   * a card is finished: a number beside a done card is an instruction to do
   * something already done.
   */
  readonly rank: number | null;
  /** True when something it depends on is still unfinished. */
  readonly rankBlocked: boolean;
  /**
   * Every file this card names already exists and it has never run.
   *
   * A suspicion the board can compute without a git call, so it can be shown on
   * every tile. The card's own view says more about why.
   */
  readonly looksFinished: boolean;
}

export interface Column {
  readonly id: string;
  readonly name: string;
  readonly position: number;
  readonly isReady: boolean;
  readonly isReviewGate: boolean;
  readonly isTerminal: boolean;
}

export interface Board {
  readonly id: string;
  readonly name: string;
  readonly cwd: string;
}

export interface HaltState {
  readonly reason: string;
  readonly cardId: string;
  readonly cardTitle: string;
  readonly detail: string;
}

export interface DispatchState {
  readonly mode: 'manual' | 'automatic';
  readonly policy: 'review' | 'unattended';
  readonly concurrency: number;
  readonly running: readonly string[];
  readonly completed: readonly string[];
  readonly halted: HaltState | null;
}

export interface MergeStep {
  readonly cardId: string;
  readonly title: string;
  readonly branch: string;
  readonly outcome: 'merged' | 'conflicted' | 'verify-failed' | 'skipped' | 'errored';
  readonly detail: string;
}

export interface MergeReport {
  readonly into: string;
  readonly steps: readonly MergeStep[];
  readonly merged: number;
  readonly stoppedAt: MergeStep | null;
  readonly clean: boolean;
  readonly summary: readonly string[];
}

export interface ResolveResult {
  readonly outcome: 'resolved' | 'still-conflicted' | 'verify-failed' | 'not-merging' | 'errored';
  readonly detail: string;
  readonly files: readonly string[];
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { 'content-type': 'application/json', ...init?.headers },
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as {
      error?: string;
      field?: string;
      reach?: string;
      detail?: string;
      outcome?: string;
    };

    // A resolver that could not finish reports why, and that detail is the whole
    // message. Replacing it with "Request failed: 409" would throw away the only
    // part the operator can act on.
    if (typeof body.outcome === 'string' && typeof body.detail === 'string') {
      throw new Error(body.detail);
    }

    // The API names the field; carrying it through means the interface can put
    // the message where the operator is looking.
    const error = new Error(body.error ?? `Request failed: ${response.status}`);
    if (body.field !== undefined) {
      (error as Error & { field?: string }).field = body.field;
    }

    // A merge gate refusal is not a failure to report as an error: it is the
    // gate working, and it arrives with something the operator can act on. The
    // `reach` field is what distinguishes it - the gate states its own limits.
    if (typeof body.reach === 'string') {
      (error as Error & { refusal?: { summary: string; reach: string } }).refusal = {
        summary: body.error ?? 'The merge was refused.',
        reach: body.reach,
      };
    }

    throw error;
  }

  return response.status === 204 ? (undefined as T) : ((await response.json()) as T);
}

export const api = {
  boards: () => request<Board[]>('/api/boards'),
  columns: (boardId: string) => request<Column[]>(`/api/boards/${boardId}/columns`),
  cards: (boardId: string) => request<Card[]>(`/api/boards/${boardId}/cards`),
  dispatchState: (boardId: string) => request<DispatchState>(`/api/boards/${boardId}/dispatch`),

  createCard: (boardId: string, title: string, priority: Card['priority'] = 'normal') =>
    request<Card>(`/api/boards/${boardId}/cards`, {
      method: 'POST',
      body: JSON.stringify({ title, priority }),
    }),

  moveCard: (cardId: string, columnId: string, index: number) =>
    request<Card>(`/api/cards/${cardId}/move`, {
      method: 'POST',
      body: JSON.stringify({ columnId, index }),
    }),

  /** Partial: only the named fields change, so two edits cannot clobber each other. */
  updateCard: (
    cardId: string,
    body: Partial<{
      title: string;
      body: string;
      goalCondition: string | null;
      agentModel: string | null;
      agentEffort: string | null;
      synthesisModel: string | null;
      priority: Card['priority'];
      status: Card['status'];
      /** Null clears it. The server refuses zero rather than reading it as none. */
      tokenCeiling: number | null;
      /** Replaces the whole set: the server reparses it, so a partial would drop rules. */
      guardrails: {
        scope?: readonly string[];
        prohibit?: readonly string[];
        allowTools?: readonly string[];
        verify?: string | null;
        maxTurns?: number | null;
      };
    }>,
  ) => request<Card>(`/api/cards/${cardId}`, { method: 'PATCH', body: JSON.stringify(body) }),

  deleteCard: (cardId: string) => request<void>(`/api/cards/${cardId}`, { method: 'DELETE' }),

  markSeen: (cardId: string) => request<Card>(`/api/cards/${cardId}/seen`, { method: 'POST' }),

  setDispatch: (boardId: string, body: { mode?: string; concurrency?: number; policy?: string }) =>
    request<DispatchState>(`/api/boards/${boardId}/dispatch`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  resumeDispatch: (boardId: string) =>
    request<DispatchState>(`/api/boards/${boardId}/dispatch/resume`, { method: 'POST' }),

  dispatchCard: (boardId: string, cardId: string) =>
    request<DispatchState>(`/api/boards/${boardId}/cards/${cardId}/dispatch`, { method: 'POST' }),

  cancelCard: (boardId: string, cardId: string) =>
    request<{ cancelled: boolean }>(`/api/boards/${boardId}/cards/${cardId}/cancel`, {
      method: 'POST',
    }),

  /**
   * The reviewer. One card or many, merged in the order given, verified after
   * each. Merged cards are moved to the terminal column by the server, so the
   * interface never has to decide what "done" means separately from the merge.
   */
  mergeCards: (
    boardId: string,
    body: { cardIds: readonly string[]; into?: string; verify?: string | null },
  ) =>
    request<MergeReport>(`/api/boards/${boardId}/review/merge`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  /**
   * Resolves the conflict the board is sitting in, then commits the merge.
   *
   * A conflict is the ordinary cost of parallel agents, so the board does the
   * work rather than handing it back. Judged from git, never from the resolver's
   * own account of itself.
   */
  resolveConflicts: (
    boardId: string,
    body: { branch?: string; into?: string; verify?: string | null },
  ) =>
    request<ResolveResult>(`/api/boards/${boardId}/review/resolve`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  /** The operator's verdict on one synthesised claim. Nothing is deleted. */
  judgeEntry: (
    entryId: string,
    body: { status: 'accepted' | 'rejected' | 'corrected'; statement?: string },
  ) =>
    request<unknown>(`/api/ledger/${entryId}/status`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  dispatchable: (boardId: string) =>
    request<{ id: string; title: string }[]>(`/api/boards/${boardId}/dispatchable`),
};

/**
 * Subscribes to board changes.
 *
 * EventSource reconnects on its own and resends Last-Event-ID, so a dropped
 * connection recovers without anything here noticing.
 */
export function subscribe(onChange: () => void, onStatus?: (live: boolean) => void): () => void {
  const source = new EventSource('/stream');

  const refresh = (): void => onChange();

  for (const event of [
    'card-created',
    'card-updated',
    'card-moved',
    'card-deleted',
    'card-seen',
    'card-merged',
    'plan-created',
    'dispatch-state',
    'run-started',
    'run-finished',
    'hook',
  ]) {
    source.addEventListener(event, refresh);
  }

  source.addEventListener('open', () => onStatus?.(true));
  source.addEventListener('error', () => onStatus?.(false));

  return () => source.close();
}
