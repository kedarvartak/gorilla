import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import {
  BRIDGE_SCRIPT_NAME,
  DEFAULT_HOOK_BASE_URL,
  bridgeScript,
} from '../../hooks/definitions.js';
import { PLAN_COMMAND_NAME, planCommand } from '../../hooks/plan-command.js';
import { mergeHookSettings, requiresBridge, type SettingsDocument } from '../../hooks/settings.js';
import type { Command, CommandResult } from '../cli.js';

export interface InitOptions {
  readonly cwd: string;
  /** Target `.claude/settings.json` instead of `.claude/settings.local.json`. */
  readonly shared: boolean;
  /** Print the resulting file without writing it. */
  readonly dryRun: boolean;
  /** Proceed even when the directory looks like neither a project nor a repo. */
  readonly force: boolean;
  readonly baseUrl: string;
}

export interface InitOutcome {
  readonly path: string;
  /** Path to the bridge script, when one was needed. */
  readonly bridgePath: string | null;
  readonly bridgeWritten: boolean;
  /** Path to the /gorilla:plan command, when written. */
  readonly commandPath: string | null;
  readonly commandWritten: boolean;
  readonly contents: string;
  /** True when this call changed the file on disk. */
  readonly written: boolean;
  /** True when nothing was written because the file already matched. */
  readonly unchanged: boolean;
  readonly dryRun: boolean;
  readonly added: string[];
  readonly replaced: string[];
  readonly preserved: number;
}

export class InitError extends Error {}

export function settingsPathFor(cwd: string, shared: boolean): string {
  return join(cwd, '.claude', shared ? 'settings.json' : 'settings.local.json');
}

/**
 * Refuse to scatter settings files into arbitrary directories. A mistyped path
 * should fail loudly rather than silently create a `.claude` directory
 * somewhere the operator never looks again.
 */
function looksLikeAProject(cwd: string): boolean {
  return existsSync(join(cwd, '.claude')) || existsSync(join(cwd, '.git'));
}

function readSettings(path: string): SettingsDocument {
  if (!existsSync(path)) return {};

  const raw = readFileSync(path, 'utf8').trim();
  if (raw === '') return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new InitError(
      `${path} is not valid JSON, so merging into it would lose data. ` +
        `Fix or remove the file and run init again.`,
      { cause },
    );
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new InitError(`${path} does not contain a JSON object.`);
  }

  return parsed as SettingsDocument;
}

export function runInit(options: InitOptions): InitOutcome {
  const cwd = resolve(options.cwd);

  if (!options.force && !looksLikeAProject(cwd)) {
    throw new InitError(
      `${cwd} contains neither a .claude directory nor a git repository. ` +
        `Run init from your project root, or pass --force.`,
    );
  }

  const path = settingsPathFor(cwd, options.shared);
  const existing = readSettings(path);

  // Some events never reach an HTTP hook, so they go through a small command
  // hook that forwards to the same endpoint (doc 14).
  const needsBridge = requiresBridge();
  const bridgePath = needsBridge ? join(cwd, '.claude', BRIDGE_SCRIPT_NAME) : null;

  const result = mergeHookSettings(existing, {
    baseUrl: options.baseUrl,
    ...(bridgePath === null ? {} : { bridgePath }),
  });
  const contents = `${JSON.stringify(result.settings, null, 2)}\n`;

  // The planning command lives with the project's other commands, so it is
  // invocable as /gorilla:plan.
  const commandPath = join(cwd, '.claude', 'commands', 'gorilla', PLAN_COMMAND_NAME);
  const desiredCommand = planCommand(options.baseUrl);
  const commandCurrent =
    existsSync(commandPath) && readFileSync(commandPath, 'utf8') === desiredCommand;

  const desiredBridge = bridgePath === null ? null : bridgeScript(options.baseUrl);
  const bridgeCurrent =
    bridgePath === null ||
    (existsSync(bridgePath) && readFileSync(bridgePath, 'utf8') === desiredBridge);

  const unchanged =
    existsSync(path) && readFileSync(path, 'utf8') === contents && bridgeCurrent && commandCurrent;

  let bridgeWritten = false;
  let commandWritten = false;

  if (!options.dryRun && !unchanged) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents, 'utf8');

    if (bridgePath !== null && desiredBridge !== null && !bridgeCurrent) {
      writeFileSync(bridgePath, desiredBridge, 'utf8');
      chmodSync(bridgePath, 0o755);
      bridgeWritten = true;
    }

    if (!commandCurrent) {
      mkdirSync(dirname(commandPath), { recursive: true });
      writeFileSync(commandPath, desiredCommand, 'utf8');
      commandWritten = true;
    }
  }

  return {
    path,
    bridgePath,
    bridgeWritten,
    commandPath,
    commandWritten,
    contents,
    written: !options.dryRun && !unchanged,
    unchanged,
    dryRun: options.dryRun,
    added: result.added,
    replaced: result.replaced,
    preserved: result.preserved,
  };
}

function parseArgs(args: readonly string[], cwd: string): InitOptions {
  let shared = false;
  let dryRun = false;
  let force = false;
  let baseUrl = DEFAULT_HOOK_BASE_URL;
  let target = cwd;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    switch (arg) {
      case '--shared':
        shared = true;
        break;
      case '--dry-run':
        dryRun = true;
        break;
      case '--force':
        force = true;
        break;
      case '--url': {
        const value = args[i + 1];
        if (value === undefined) throw new InitError('--url requires a value');
        baseUrl = value;
        i += 1;
        break;
      }
      case '--dir': {
        const value = args[i + 1];
        if (value === undefined) throw new InitError('--dir requires a value');
        target = value;
        i += 1;
        break;
      }
      default:
        throw new InitError(`Unknown option for init: ${String(arg)}`);
    }
  }

  return { cwd: target, shared, dryRun, force, baseUrl };
}

export const initCommand: Command = {
  name: 'init',
  summary: 'Write Gorilla hook configuration into this project',
  run(args: readonly string[]): CommandResult {
    let outcome: InitOutcome;
    try {
      outcome = runInit(parseArgs(args, process.cwd()));
    } catch (error) {
      if (error instanceof InitError) {
        return { exitCode: 1, stdout: '', stderr: error.message };
      }
      throw error;
    }

    const counts =
      `${outcome.added.length} added, ${outcome.replaced.length} updated, ` +
      `${outcome.preserved} existing entr(ies) preserved`;

    const bridgeNote =
      (outcome.bridgePath === null
        ? ''
        : `\n  Bridge script: ${outcome.bridgePath} (forwards events the HTTP transport does not receive)`) +
      `\n  Planning command: /gorilla:plan`;

    if (outcome.dryRun) {
      return {
        exitCode: 0,
        stdout: `Would write ${outcome.path}:\n\n${outcome.contents.trimEnd()}\n\n${counts}.${bridgeNote}`,
        stderr: '',
      };
    }

    if (outcome.unchanged) {
      return {
        exitCode: 0,
        stdout: `${outcome.path} is already up to date.`,
        stderr: '',
      };
    }

    return {
      exitCode: 0,
      stdout: `Wrote ${outcome.path}\n  ${counts}.${bridgeNote}`,
      stderr: '',
    };
  },
};
