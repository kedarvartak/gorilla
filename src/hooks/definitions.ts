/**
 * The canonical set of hook events Gorilla subscribes to (doc 07 section 1).
 *
 * `init` (T4) writes these into a settings file and `doctor` (T8) checks them
 * against what has actually been delivered, so both read this one list rather
 * than each carrying their own copy.
 */

export interface HookDefinition {
  /** Hook event name, exactly as Claude Code emits it. */
  readonly event: string;
  /**
   * Restricts which occurrences fire. Omitted means every occurrence.
   *
   * Tool events are matched to mutating tools plus Bash: matching everything
   * multiplies volume by an order of magnitude for Read and Grep calls that
   * tell the operator nothing (doc 07).
   */
  readonly matcher?: string;
  /** Seconds. Only set where the default is not appropriate. */
  readonly timeout?: number;
  /** Why this event is subscribed to, for `doctor` output and documentation. */
  readonly purpose: string;
}

const MUTATING_TOOLS = 'Edit|Write|NotebookEdit|Bash';

export const HOOK_DEFINITIONS: readonly HookDefinition[] = [
  { event: 'SessionStart', purpose: 'Bind a session to a card; inject card and project context' },
  { event: 'UserPromptSubmit', purpose: 'Record operator intent verbatim' },
  { event: 'PreToolUse', matcher: MUTATING_TOOLS, purpose: 'Intent before action' },
  {
    event: 'PostToolUse',
    matcher: MUTATING_TOOLS,
    purpose: 'What changed; source of the diff digest',
  },
  {
    event: 'PostToolUseFailure',
    purpose: 'Failure and recovery narrative; source of risk entries',
  },
  {
    event: 'PreCompact',
    timeout: 120,
    purpose: 'Capture context before it is discarded - the highest-value event',
  },
  { event: 'PostCompact', purpose: 'Mark the discontinuity on the card timeline' },
  { event: 'SubagentStart', purpose: 'Work done in context windows the operator never sees' },
  { event: 'SubagentStop', purpose: 'A subagent context window is discarded here' },
  { event: 'TaskCreated', purpose: "Sync with Claude Code's own task list" },
  { event: 'TaskCompleted', purpose: 'Completion signal; gate point in Phase 3' },
  { event: 'Notification', purpose: 'Card needs human attention' },
  { event: 'Stop', purpose: 'End of turn; gate point in Phase 3' },
  { event: 'StopFailure', purpose: 'Distinguishes finishing from dying on a rate limit' },
  { event: 'SessionEnd', purpose: 'Close out the binding' },
];

export const DEFAULT_HOOK_BASE_URL = 'http://127.0.0.1:4300';

/** Marks entries as ours so `init` can replace them instead of duplicating. */
export function hookUrl(baseUrl: string, event: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/hooks/${event}`;
}

export function isGorillaHookUrl(url: unknown, baseUrl: string): boolean {
  return typeof url === 'string' && url.startsWith(`${baseUrl.replace(/\/+$/, '')}/hooks/`);
}
