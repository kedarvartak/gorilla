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
  /** Used only for windows that escalate - compaction, and manual re-extraction. */
  readonly synthesisModel: string | null;
  readonly lastSeenAt: number | null;
  readonly updatedAt: number;
  readonly guardrailDetail: readonly GuardrailDetail[];
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
  /** What happens inside a run when the agent needs the operator. */
  readonly autonomy: 'copilot' | 'autopilot';
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

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { 'content-type': 'application/json', ...init?.headers },
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string; field?: string };
    // The API names the field; carrying it through means the interface can put
    // the message where the operator is looking.
    const error = new Error(body.error ?? `Request failed: ${response.status}`);
    if (body.field !== undefined) {
      (error as Error & { field?: string }).field = body.field;
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
    }>,
  ) => request<Card>(`/api/cards/${cardId}`, { method: 'PATCH', body: JSON.stringify(body) }),

  deleteCard: (cardId: string) => request<void>(`/api/cards/${cardId}`, { method: 'DELETE' }),

  markSeen: (cardId: string) => request<Card>(`/api/cards/${cardId}/seen`, { method: 'POST' }),

  setDispatch: (
    boardId: string,
    body: { mode?: string; concurrency?: number; policy?: string; autonomy?: string },
  ) =>
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
