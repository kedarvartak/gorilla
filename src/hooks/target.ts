import type { SettingsDocument } from './settings.js';

/**
 * Whether the hooks point at the board that is running (doc 07).
 *
 * The quietest way to lose everything. `gorilla init` writes hook entries
 * naming a port; `gorilla serve --port` starts the board on another. Both halves
 * are individually correct - the settings register all seventeen hooks, the
 * server is up and answering - and every event goes to a closed port on the way
 * between them.
 *
 * What the operator sees is a board that is running and empty, which is exactly
 * what a board looks like before anything has happened. So this compares the two
 * facts against each other rather than each against a default, which is how the
 * mismatch stayed invisible: `doctor` checked the settings against
 * `DEFAULT_HOOK_BASE_URL` and the port against nothing at all.
 */

export interface HookTarget {
  readonly event: string;
  readonly url: string;
}

/**
 * Every Gorilla hook endpoint named in a settings document.
 *
 * Found by shape rather than by base URL. Looking for a known base is what
 * makes a hook pointing somewhere else invisible, and somewhere else is the
 * entire problem being diagnosed.
 */
export function hookTargets(doc: SettingsDocument): HookTarget[] {
  const found: HookTarget[] = [];

  for (const [event, groups] of Object.entries(doc.hooks ?? {})) {
    if (!Array.isArray(groups)) continue;

    for (const group of groups) {
      for (const handler of group?.hooks ?? []) {
        // `gorillaUrl` is how a bridged command hook records the endpoint it
        // forwards to; without it a bridged event would look unconfigured.
        const candidate = handler?.url ?? handler?.['gorillaUrl'];
        if (typeof candidate !== 'string' || !candidate.includes('/hooks/')) continue;
        found.push({ event, url: candidate });
      }
    }
  }

  return found;
}

/** The port a hook URL delivers to, or null when it cannot be read. */
export function portOf(url: string): number | null {
  try {
    const parsed = new URL(url);
    if (parsed.port !== '') return Number(parsed.port);
    return parsed.protocol === 'https:' ? 443 : 80;
  } catch {
    return null;
  }
}

/**
 * The base URL a settings document's own hooks use.
 *
 * So that "are all the hooks registered?" is asked about the board the settings
 * actually name. Asking it against a constant means a project deliberately
 * serving elsewhere reads as out of date, which sends the operator to `init`
 * for a problem `init` is not having.
 */
export function configuredBaseUrl(doc: SettingsDocument): string | null {
  for (const target of hookTargets(doc)) {
    try {
      return new URL(target.url).origin;
    } catch {
      continue;
    }
  }
  return null;
}

export type TargetVerdict = 'agree' | 'mismatch' | 'unconfigured';

export interface TargetAssessment {
  readonly verdict: TargetVerdict;
  readonly detail: string;
  /** Ports the settings name, in the order first seen. */
  readonly configured: readonly number[];
}

export interface TargetInput {
  readonly doc: SettingsDocument;
  /** The port the board is serving on, or is about to. */
  readonly port: number;
  readonly settingsPath?: string;
  /** Only for the advice line; the comparison is on the port alone. */
  readonly host?: string;
}

export function assessHookTarget(input: TargetInput): TargetAssessment {
  const targets = hookTargets(input.doc);
  const where = input.settingsPath === undefined ? 'The settings' : input.settingsPath;

  if (targets.length === 0) {
    return {
      verdict: 'unconfigured',
      detail: `${where} registers no Gorilla hooks. Run \`gorilla init\`.`,
      configured: [],
    };
  }

  const configured: number[] = [];
  for (const target of targets) {
    const port = portOf(target.url);
    if (port !== null && !configured.includes(port)) configured.push(port);
  }

  if (configured.includes(input.port)) {
    return {
      verdict: 'agree',
      detail: `${where} sends hooks to port ${String(input.port)}, where the board is.`,
      configured,
    };
  }

  // Named rather than described. An operator staring at an empty board needs
  // the two numbers side by side to see the problem at all.
  return {
    verdict: 'mismatch',
    detail:
      `${where} sends hooks to port ${configured.map(String).join(', ')}, ` +
      `but the board is on ${String(input.port)}. Every event is being dropped ` +
      `between the two. Either rewrite the hooks with ` +
      `\`gorilla init --url http://${input.host ?? '127.0.0.1'}:${String(input.port)}\`, ` +
      `or serve on ${String(configured[0] ?? input.port)}.`,
    configured,
  };
}
