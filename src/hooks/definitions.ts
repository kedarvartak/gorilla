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
  /**
   * How the event reaches the board.
   *
   * `http` posts directly. `bridge` goes through a small command hook that
   * forwards to the same endpoint, which is required for events HTTP hooks do
   * not receive - measured, not assumed (doc 14). Defaults to `http`.
   */
  readonly transport?: 'http' | 'bridge';
  /** Why this event is subscribed to, for `doctor` output and documentation. */
  readonly purpose: string;
}

const MUTATING_TOOLS = 'Edit|Write|NotebookEdit|Bash';

export const HOOK_DEFINITIONS: readonly HookDefinition[] = [
  {
    event: 'SessionStart',
    // Measured on Claude Code 2.1.233: HTTP hooks never receive this event,
    // while a command hook in the same settings file does (doc 14). Session
    // binding and compaction repair both depend on it, so it is bridged.
    transport: 'bridge',
    purpose: 'Bind a session to a card; inject card and project context',
  },
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
  {
    event: 'PermissionRequest',
    purpose: 'A tool call is waiting on a decision',
  },
  {
    event: 'PermissionDenied',
    // Fires when auto mode denies a call. It does NOT fire under dontAsk,
    // where a denial appears only as a PreToolUse with no PostToolUse - which
    // is why the board also detects unresolved tool intents (doc 15).
    purpose: 'A tool call was refused; becomes a ledger risk entry',
  },
  { event: 'Notification', purpose: 'Card needs human attention' },
  { event: 'Stop', purpose: 'End of turn; gate point in Phase 3' },
  { event: 'StopFailure', purpose: 'Distinguishes finishing from dying on a rate limit' },
  { event: 'SessionEnd', purpose: 'Close out the binding' },
];

export const DEFAULT_HOOK_BASE_URL = 'http://127.0.0.1:4300';

/** Written into .claude/ by `init` when any event needs the bridge. */
export const BRIDGE_SCRIPT_NAME = 'gorilla-bridge.sh';

/**
 * Forwards a hook payload to the board and relays the board's JSON reply on
 * stdout, which is where Claude Code reads a command hook's decision.
 *
 * Uses only curl, so it adds no dependency beyond what a developer machine
 * already has, and exits 0 unconditionally: a board that is down or slow must
 * never be why a tool call fails (doc 06, fail open).
 */
export function bridgeScript(baseUrl: string): string {
  return `#!/usr/bin/env bash
# Written by \`gorilla init\`. Forwards hook events the HTTP transport does not
# receive, and relays the board's reply so context injection still works.
# Safe to delete; re-run \`gorilla init\` to restore.
event="$1"
curl -sS -m 30 -X POST \\
  -H 'content-type: application/json' \\
  --data-binary @- \\
  "${baseUrl.replace(/\/+$/, '')}/hooks/$event" 2>/dev/null
exit 0
`;
}

/** Marks entries as ours so `init` can replace them instead of duplicating. */
export function hookUrl(baseUrl: string, event: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/hooks/${event}`;
}

export function isGorillaHookUrl(url: unknown, baseUrl: string): boolean {
  return typeof url === 'string' && url.startsWith(`${baseUrl.replace(/\/+$/, '')}/hooks/`);
}
