import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * Finding transcript files on disk.
 *
 * Hook payloads carry `transcript_path` directly, so this is only needed for
 * backfill (doc 06): reconstructing runs from sessions that happened while the
 * board was not running.
 */

export interface LocatedTranscript {
  readonly path: string;
  readonly sessionId: string;
  readonly sizeBytes: number;
  readonly modifiedAt: number;
}

/**
 * Claude Code slugifies the working directory by replacing every character
 * outside [A-Za-z0-9] with a hyphen. Derived from observed directory names such
 * as `-home-kedar-Desktop-Projects-kanban`; treat it as a heuristic, and prefer
 * the `transcript_path` a hook hands us whenever one is available.
 */
export function slugForCwd(cwd: string): string {
  return resolve(cwd).replace(/[^A-Za-z0-9]/g, '-');
}

export function transcriptDirForCwd(cwd: string, home = homedir()): string {
  return join(home, '.claude', 'projects', slugForCwd(cwd));
}

/** Transcripts for a working directory, newest first. Never throws. */
export function findTranscripts(cwd: string, home = homedir()): LocatedTranscript[] {
  const dir = transcriptDirForCwd(cwd, home);
  if (!existsSync(dir)) return [];

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }

  const found: LocatedTranscript[] = [];

  for (const entry of entries) {
    if (!entry.endsWith('.jsonl')) continue;

    const path = join(dir, entry);
    try {
      const stats = statSync(path);
      if (!stats.isFile()) continue;

      found.push({
        path,
        sessionId: entry.slice(0, -'.jsonl'.length),
        sizeBytes: stats.size,
        modifiedAt: stats.mtimeMs,
      });
    } catch {
      // A file that vanished between readdir and stat is not an error.
      continue;
    }
  }

  return found.sort((a, b) => b.modifiedAt - a.modifiedAt);
}
