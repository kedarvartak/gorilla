import {
  DEFAULT_HOOK_BASE_URL,
  HOOK_DEFINITIONS,
  hookUrl,
  isGorillaHookUrl,
} from './definitions.js';

/**
 * Merging of Gorilla's hook entries into a Claude Code settings document.
 *
 * Kept as pure functions over plain objects so the merge - the part that can
 * destroy an operator's configuration - is tested directly, without a
 * filesystem.
 */

export interface HookHandler {
  readonly type: string;
  readonly url?: string;
  readonly timeout?: number;
  readonly [key: string]: unknown;
}

export interface HookGroup {
  readonly matcher?: string;
  readonly hooks: HookHandler[];
  readonly [key: string]: unknown;
}

export interface SettingsDocument {
  hooks?: Record<string, HookGroup[]>;
  [key: string]: unknown;
}

export interface MergeOptions {
  readonly baseUrl?: string;
  /**
   * Absolute path to the bridge script, required when any definition uses the
   * `bridge` transport. `init` writes the script and passes its path.
   */
  readonly bridgePath?: string;
}

export interface MergeResult {
  readonly settings: SettingsDocument;
  readonly added: string[];
  readonly replaced: string[];
  /** Entries belonging to something other than Gorilla, left untouched. */
  readonly preserved: number;
}

function gorillaGroupFor(event: string, baseUrl: string, bridgePath?: string): HookGroup {
  const definition = HOOK_DEFINITIONS.find((d) => d.event === event);
  const timeout = definition?.timeout === undefined ? {} : { timeout: definition.timeout };

  // A bridged event goes through a command hook that forwards to the same
  // endpoint, because HTTP hooks do not receive it (doc 14). The URL is still
  // ours, which is what lets the merge recognise and replace its own entries.
  const handler: HookHandler =
    definition?.transport === 'bridge' && bridgePath !== undefined
      ? {
          type: 'command',
          command: `${bridgePath} ${event}`,
          ...timeout,
          gorillaUrl: hookUrl(baseUrl, event),
        }
      : { type: 'http', url: hookUrl(baseUrl, event), ...timeout };

  return {
    ...(definition?.matcher === undefined ? {} : { matcher: definition.matcher }),
    hooks: [handler],
  };
}

function groupIsOurs(group: HookGroup, baseUrl: string): boolean {
  return (
    Array.isArray(group.hooks) &&
    group.hooks.some(
      (h) => isGorillaHookUrl(h?.url, baseUrl) || isGorillaHookUrl(h?.['gorillaUrl'], baseUrl),
    )
  );
}

/**
 * Returns a new document with Gorilla's hooks present exactly once per event.
 *
 * Never mutates the input, never drops a group it does not own, and replaces
 * rather than appends its own groups so that running twice is a no-op.
 */
/** True when any registered event needs the command bridge. */
export function requiresBridge(): boolean {
  return HOOK_DEFINITIONS.some((definition) => definition.transport === 'bridge');
}

export function bridgedEvents(): readonly string[] {
  return HOOK_DEFINITIONS.filter((d) => d.transport === 'bridge').map((d) => d.event);
}

export function mergeHookSettings(
  existing: SettingsDocument,
  options: MergeOptions = {},
): MergeResult {
  const baseUrl = options.baseUrl ?? DEFAULT_HOOK_BASE_URL;

  const merged: SettingsDocument = { ...existing };
  const hooks: Record<string, HookGroup[]> = { ...(existing.hooks ?? {}) };

  const added: string[] = [];
  const replaced: string[] = [];
  let preserved = 0;

  for (const definition of HOOK_DEFINITIONS) {
    const { event } = definition;
    const current = hooks[event] ?? [];

    const foreign = current.filter((group) => !groupIsOurs(group, baseUrl));
    const ours = current.filter((group) => groupIsOurs(group, baseUrl));

    preserved += foreign.length;
    if (ours.length > 0) replaced.push(event);
    else added.push(event);

    hooks[event] = [...foreign, gorillaGroupFor(event, baseUrl, options.bridgePath)];
  }

  // Events Gorilla does not subscribe to are copied through untouched by the
  // spread above; nothing further to do for them.
  merged.hooks = hooks;
  return { settings: merged, added, replaced, preserved };
}

/** True when the document already contains exactly what a merge would produce. */
export function isUpToDate(existing: SettingsDocument, options: MergeOptions = {}): boolean {
  const { settings } = mergeHookSettings(existing, options);
  return JSON.stringify(settings) === JSON.stringify(existing);
}
