import { existsSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Whether the interface being served was built from this server's source
 * (T1, T2, T80).
 *
 * The failure this exists for has now happened twice. A server keeps running
 * from an old build while new routes are added; the browser loads the old
 * bundle; every new endpoint 404s and the board looks healthy. Nothing in the
 * system could tell, because the two facts - what the server serves and what
 * the bundle expects - were never compared with each other.
 *
 * It reports rather than refuses. A board that will not start because its
 * bundle is stale leaves the operator with nothing, and the stale bundle is
 * usually still perfectly usable for whatever they came to do. Being told is
 * the whole ask; a locked door is a different and worse product.
 */

/**
 * Which of the two is behind.
 *
 * `interface-behind` is the milder half: the board shows an older view of a
 * server that has everything. `server-behind` is the half that 404s - the
 * bundle in the browser calls routes this process was never loaded with - and
 * it was the half this stamp used to call healthy (T80).
 */
export type BuildDirection = 'interface-behind' | 'server-behind';

export interface BuildStamp {
  /** When the served interface was built. Null when nothing is built. */
  readonly webBuiltAt: number | null;
  /**
   * When the code this process is running was built. Null when running from
   * source. This is the running process's own file, not whatever happens to be
   * sitting in `dist/` now: see `runningServerBuiltAt`.
   */
  readonly serverBuiltAt: number | null;
  readonly stale: boolean;
  /** Which side is behind, or null when they agree. */
  readonly direction: BuildDirection | null;
  /** What to tell the operator, or null when there is nothing to say. */
  readonly note: string | null;
}

/**
 * A minute, in either direction, so an ordinary `npm run build` does not look
 * stale.
 *
 * `tsc` and `vite build` run in sequence and finish seconds apart, in that
 * order, which means the interface is always marginally newer than the server
 * it belongs to. A stamp that reported that would cry wolf on every build and
 * be ignored by the second week.
 */
export const TOLERANCE_MS = 60_000;

function builtAt(path: string): number | null {
  return existsSync(path) ? statSync(path).mtimeMs : null;
}

/**
 * When the code running right now was built, read once as this module loads.
 *
 * Read from `import.meta.url` - the file this process actually loaded - rather
 * than from a guessed path under `dist/`, and captured at load rather than per
 * request. Both halves matter. Stat'ing `dist/server/app.js` on each call
 * describes a file on disk that a `npm run build` has since replaced, so
 * rebuilding under a live server cleared the warning while every new route
 * still 404'd, which is precisely the state the stamp exists to catch. A
 * process cannot be rebuilt, only restarted, and this value only changes when
 * one happens.
 */
const runningBuiltAt: number | null = (() => {
  const self = fileURLToPath(import.meta.url);
  // A `.ts` path means tsx or vitest is executing the source directly. There
  // is no build to be behind, and dating the server by when someone last saved
  // a file would be a different claim than the one this makes.
  return self.endsWith('.js') ? builtAt(self) : null;
})();

/** When the code this process is running was built, or null if from source. */
export function runningServerBuiltAt(): number | null {
  return runningBuiltAt;
}

function candidates(here: string): { web: string[] } {
  return {
    web: [
      resolve(here, '../../../dist/web/index.html'),
      resolve(here, '../../../../dist/web/index.html'),
    ],
  };
}

export function readBuildStamp(
  from?: string,
  serverBuiltAt: number | null = runningServerBuiltAt(),
): BuildStamp {
  const here = from ?? dirname(fileURLToPath(import.meta.url));

  // The interface is read fresh every time: what is on disk now is what the
  // next browser to ask will be handed. The server is not, because what is on
  // disk is not what this process is running.
  const webBuiltAt =
    candidates(here)
      .web.map(builtAt)
      .find((at) => at !== null) ?? null;

  return describe(webBuiltAt, serverBuiltAt);
}

function minutes(gap: number): string {
  return String(Math.round(Math.abs(gap) / 60_000));
}

export function describe(webBuiltAt: number | null, serverBuiltAt: number | null): BuildStamp {
  // Running from source, or nothing built. Neither is a mismatch: there is no
  // second artefact to disagree with, and inventing a warning here would train
  // the operator to dismiss the one that matters.
  if (webBuiltAt === null || serverBuiltAt === null) {
    return { webBuiltAt, serverBuiltAt, stale: false, direction: null, note: null };
  }

  const gap = serverBuiltAt - webBuiltAt;
  if (Math.abs(gap) <= TOLERANCE_MS) {
    return { webBuiltAt, serverBuiltAt, stale: false, direction: null, note: null };
  }

  // Both notes say what to do about it. A warning the operator cannot act on
  // is noise, and each of these has exactly one fix.
  const reported =
    gap > 0
      ? {
          direction: 'interface-behind' as const,
          note: `The interface was built ${minutes(gap)} minute(s) before the server it is being served by. Anything added since will be missing from the board and its requests may 404. Run \`npm run build\` and restart.`,
        }
      : {
          direction: 'server-behind' as const,
          note: `The interface was built ${minutes(gap)} minute(s) after the server now running it. This server was loaded before those changes, so routes the board calls will 404 however many times it is rebuilt. Restart the board.`,
        };

  return { webBuiltAt, serverBuiltAt, stale: true, ...reported };
}

/** Where the built interface came from, for the diagnostics view. */
export function webRootFor(here: string): string | null {
  return (
    candidates(here)
      .web.filter((candidate) => existsSync(candidate))
      .map((candidate) => join(dirname(candidate)))[0] ?? null
  );
}
