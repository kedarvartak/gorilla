import { existsSync, readFileSync } from 'node:fs';

import { assessHookTarget } from './target.js';
import { DEFAULT_HOST } from '../server/index.js';
import type { SettingsDocument } from './settings.js';

/**
 * The startup warning for hooks pointing at the wrong board (doc 07).
 *
 * Kept out of `serve` itself so the filesystem reads are in one place and can
 * fail without taking the server with them: a board that refused to start
 * because it could not read a settings file would be a worse outcome than the
 * misconfiguration it was trying to report.
 */

/** Where Claude Code keeps project settings, most specific first. */
const SETTINGS_FILES = ['.claude/settings.local.json', '.claude/settings.json'];

export function hookTargetWarning(cwd: string, port: number, host = DEFAULT_HOST): string | null {
  for (const relative of SETTINGS_FILES) {
    const path = `${cwd}/${relative}`;
    if (!existsSync(path)) continue;

    let doc: SettingsDocument;
    try {
      doc = JSON.parse(readFileSync(path, 'utf8')) as SettingsDocument;
    } catch {
      // An unreadable settings file is `doctor`'s problem to report properly.
      // Guessing at it here would produce a scarier message than the truth.
      continue;
    }

    const assessment = assessHookTarget({ doc, port, settingsPath: relative, host });
    if (assessment.verdict === 'mismatch') return assessment.detail;
    // The first file that configures anything is the one in force; a later one
    // agreeing or disagreeing does not change what Claude Code will send.
    if (assessment.verdict === 'agree') return null;
  }

  return null;
}
