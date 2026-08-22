import { existsSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Whether the interface being served was built from this server's source
 * (T1, T2).
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

export interface BuildStamp {
  /** When the served interface was built. Null when nothing is built. */
  readonly webBuiltAt: number | null;
  /** When the server's own code was built. Null when running from source. */
  readonly serverBuiltAt: number | null;
  readonly stale: boolean;
  /** What to tell the operator, or null when there is nothing to say. */
  readonly note: string | null;
}

/**
 * A minute, so an ordinary `npm run build` does not look stale.
 *
 * `tsc` and `vite build` run in sequence and finish seconds apart, in that
 * order, which means the interface is always marginally older than the server
 * it belongs to. A stamp that reported that would cry wolf on every build and
 * be ignored by the second week.
 */
export const TOLERANCE_MS = 60_000;

function builtAt(path: string): number | null {
  return existsSync(path) ? statSync(path).mtimeMs : null;
}

function candidates(here: string): { web: string[]; server: string[] } {
  return {
    web: [
      resolve(here, '../../../dist/web/index.html'),
      resolve(here, '../../../../dist/web/index.html'),
    ],
    server: [
      resolve(here, '../../../dist/server/app.js'),
      resolve(here, '../../../../dist/server/app.js'),
    ],
  };
}

export function readBuildStamp(from?: string): BuildStamp {
  const here = from ?? dirname(fileURLToPath(import.meta.url));
  const paths = candidates(here);

  const webBuiltAt = paths.web.map(builtAt).find((at) => at !== null) ?? null;
  const serverBuiltAt = paths.server.map(builtAt).find((at) => at !== null) ?? null;

  return describe(webBuiltAt, serverBuiltAt);
}

export function describe(webBuiltAt: number | null, serverBuiltAt: number | null): BuildStamp {
  // Running from source, or nothing built. Neither is a mismatch: there is no
  // second artefact to disagree with, and inventing a warning here would train
  // the operator to dismiss the one that matters.
  if (webBuiltAt === null || serverBuiltAt === null) {
    return { webBuiltAt, serverBuiltAt, stale: false, note: null };
  }

  const behindBy = serverBuiltAt - webBuiltAt;
  if (behindBy <= TOLERANCE_MS) {
    return { webBuiltAt, serverBuiltAt, stale: false, note: null };
  }

  const minutes = Math.round(behindBy / 60_000);
  return {
    webBuiltAt,
    serverBuiltAt,
    stale: true,
    // Says what to do about it. A warning the operator cannot act on is noise,
    // and this one has exactly one fix.
    note: `The interface was built ${String(minutes)} minute(s) before the server it is being served by. Anything added since will be missing from the board and its requests may 404. Run \`npm run build\` and restart.`,
  };
}

/** Where the built interface came from, for the diagnostics view. */
export function webRootFor(here: string): string | null {
  return (
    candidates(here)
      .web.filter((candidate) => existsSync(candidate))
      .map((candidate) => join(dirname(candidate)))[0] ?? null
  );
}
