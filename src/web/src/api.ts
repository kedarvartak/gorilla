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
  /** Tokens the queue may spend today. Null means no budget. */
  readonly budget: number | null;
  readonly spend: {
    readonly tokens: number;
    readonly runs: number;
    /** Runs that recorded no usage, so the total is a lower bound. */
    readonly unrecorded: number;
  };
  readonly spendNote: string;
  /** Cards that failed since the last one succeeded. Three stops the queue. */
  readonly failureStreak: number;
  /** Why the queue is not starting anything, when the reason is not a halt. */
  readonly holdingFor: string | null;
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

/**
 * For a request whose failure must not take the screen down with it (T12).
 *
 * Several panels load something alongside the thing the operator asked for -
 * a shortlist, a subagent view, a set of proposals - and a card that will not
 * open because a secondary route answered 404 is a worse outcome than a card
 * missing one section.
 *
 * The guard is the other half. A server older than this bundle answers some
 * of these with something else entirely, and `as T` would push that straight
 * into a render. Six web tests failed exactly that way before this existed.
 */
async function optional<T>(url: string, isValid: (value: unknown) => boolean): Promise<T | null> {
  try {
    // No content-type: there is no body to describe, and a GET that announces
    // one is noise in every network log that ever reads it.
    const response = await fetch(url);
    if (!response.ok) return null;

    const body: unknown = await response.json();
    return isValid(body) ? (body as T) : null;
  } catch {
    return null;
  }
}

/** Anything shaped like a list. The commonest optional response here. */
export function isList(value: unknown): boolean {
  return Array.isArray(value);
}

/** Anything shaped like an object, which is the other one. */
export function isRecord(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export const api = {
  boards: () => request<Board[]>('/api/boards'),
  columns: (boardId: string) => request<Column[]>(`/api/boards/${boardId}/columns`),
  cards: (boardId: string) => request<Card[]>(`/api/boards/${boardId}/cards`),
  dispatchState: (boardId: string) => request<DispatchState>(`/api/boards/${boardId}/dispatch`),

  createCard: (boardId: string, title: string, priority: Card['priority'] = 'normal') =>
    request<Card & { duplicateNote?: string | null }>(`/api/boards/${boardId}/cards`, {
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

  setBoard: (
    boardId: string,
    body: {
      dailyTokenBudget?: number | null;
      name?: string;
      /** Both or neither: one hour on its own describes no window. */
      dispatchFromHour?: number | null;
      dispatchToHour?: number | null;
    },
  ) => request<Board>(`/api/boards/${boardId}`, { method: 'PATCH', body: JSON.stringify(body) }),

  setDispatch: (boardId: string, body: { mode?: string; concurrency?: number; policy?: string }) =>
    request<DispatchState>(`/api/boards/${boardId}/dispatch`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  resumeDispatch: (boardId: string) =>
    request<DispatchState>(`/api/boards/${boardId}/dispatch/resume`, { method: 'POST' }),

  dispatchCard: (boardId: string, cardId: string) =>
    request<DispatchState>(`/api/boards/${boardId}/cards/${cardId}/dispatch`, { method: 'POST' }),

  /** Sends a blocked card back to the queue, keeping its worktree (T21, T22). */
  retryCard: (boardId: string, cardId: string, note: string | null) =>
    request<DispatchState>(`/api/boards/${boardId}/cards/${cardId}/retry`, {
      method: 'POST',
      body: JSON.stringify({ note }),
    }),

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

  /** Turns a rejected entry into the card that addresses it (T38). */
  followUp: (entryId: string, title?: string) =>
    request<Card>(`/api/ledger/${entryId}/follow-up`, {
      method: 'POST',
      body: JSON.stringify(title === undefined ? {} : { title }),
    }),

  /** Entries worth turning into rules (T14). A shortlist, never applied on its own. */
  guardrailProposals: (cardId: string) =>
    request<GuardrailProposal[]>(`/api/cards/${cardId}/guardrail-proposals`),

  /** Turns one accepted entry into a card guardrail. */
  promoteEntry: (entryId: string, body: { target: string; rule: string }) =>
    request<{ card: Card; enforcement: 'hard' | 'advisory'; detail: string }>(
      `/api/ledger/${entryId}/promote`,
      { method: 'POST', body: JSON.stringify(body) },
    ),

  /** Finds a card by its words or by a file it touched (T34). */
  search: (boardId: string, query: string) =>
    request<SearchHit[]>(`/api/boards/${boardId}/search?q=${encodeURIComponent(query)}`),

  /** Refuses a duplicate with a 409, which the panel shows rather than swallows. */
  addInvariant: (boardId: string, statement: string) =>
    request<{ id: string }>(`/api/boards/${boardId}/invariants`, {
      method: 'POST',
      body: JSON.stringify({ statement }),
    }),

  removeInvariant: (boardId: string, invariantId: string) =>
    request<void>(`/api/boards/${boardId}/invariants/${invariantId}`, { method: 'DELETE' }),

  /* Everything below loads alongside something else. A failure here removes a
     section, never the screen. */

  cardDetail: <T>(cardId: string) => optional<T>(`/api/cards/${cardId}/detail`, isRecord),
  cardBrief: <T>(cardId: string) => optional<T>(`/api/cards/${cardId}/brief`, isRecord),
  cardSubagents: <T>(cardId: string) => optional<T[]>(`/api/cards/${cardId}/subagents`, isList),
  cardProposals: <T>(cardId: string) =>
    optional<T[]>(`/api/cards/${cardId}/guardrail-proposals`, isList),
  invariants: <T>(boardId: string) => optional<T[]>(`/api/boards/${boardId}/invariants`, isList),
  invariantProposals: <T>(boardId: string) =>
    optional<T[]>(`/api/boards/${boardId}/invariant-proposals`, isList),
  digest: <T>(boardId: string) => optional<T>(`/api/boards/${boardId}/digest`, isRecord),
  health: <T>() => optional<T>('/health', isRecord),

  runTimeline: <T>(runId: string, query: URLSearchParams) =>
    optional<T>(`/api/runs/${runId}/timeline?${query.toString()}`, isRecord),

  runFacets: <T>(runId: string) => optional<T>(`/api/runs/${runId}/facets`, isRecord),

  /** Text rather than JSON, so it does not go through the typed client. */
  cardBriefMarkdown: async (cardId: string): Promise<string> => {
    const response = await fetch(`/api/cards/${cardId}/brief.md`);
    if (!response.ok) throw new Error(`Could not export the brief: ${String(response.status)}`);
    return response.text();
  },

  /** One file's patch. A branch that is gone reads as a message, not an error. */
  cardDiff: async (cardId: string, path: string): Promise<string> => {
    const response = await fetch(`/api/cards/${cardId}/diff?path=${encodeURIComponent(path)}`);
    return response.ok ? response.text() : 'That file could not be read.';
  },

  markSeenQuietly: (cardId: string) =>
    fetch(`/api/cards/${cardId}/seen`, { method: 'POST' }).catch(() => undefined),

  dispatchable: (boardId: string) =>
    request<{ id: string; title: string }[]>(`/api/boards/${boardId}/dispatchable`),
};

export interface SearchHit {
  readonly cardId: string;
  readonly title: string;
  /** Why it matched, so a surprising hit explains itself. */
  readonly matched: readonly ('title' | 'body' | 'path')[];
  readonly path: string | null;
}

export interface GuardrailProposal {
  readonly entryId: string;
  readonly statement: string;
  readonly target: 'scope' | 'prohibit' | 'verify';
  readonly rule: string;
  /** What the board could actually do with it. Never presented as more. */
  readonly enforcement: 'hard' | 'advisory';
  readonly why: string;
}

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
