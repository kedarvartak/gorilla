import { existsSync, readFileSync, statSync } from 'node:fs';
import { createConnection } from 'node:net';
import { join } from 'node:path';

import { settingsPathFor } from './init.js';
import {
  BRIDGE_SCRIPT_NAME,
  DEFAULT_HOOK_BASE_URL,
  HOOK_DEFINITIONS,
} from '../../hooks/definitions.js';
import { isUpToDate, requiresBridge, type SettingsDocument } from '../../hooks/settings.js';
import { openDatabase, resolveDatabasePath } from '../../server/db/client.js';
import { DEFAULT_PORT, DEFAULT_HOST } from '../../server/index.js';
import { readTranscript } from '../../server/transcript/index.js';
import { NOTIFY_ENV } from '../../server/notify/notify.js';
import { isDeliverable, WEBHOOK_ENV } from '../../server/notify/webhook.js';
import { owningBoardCwd } from '../../server/ingest/binding.js';
import { assessHookTarget, configuredBaseUrl } from '../../hooks/target.js';
import type { Command, CommandResult } from '../cli.js';

/**
 * `gorilla doctor` - the diagnostic that makes P7 real.
 *
 * The system announces what it cannot see. A silent hook, a stale settings
 * file, or a transcript format that has drifted are all conditions where the
 * board keeps working but knows less than the operator assumes - which is the
 * precise failure this product exists to prevent, turned on itself.
 *
 * Exits non-zero when anything is misconfigured, so T10's verification run can
 * gate on it.
 */

export type CheckStatus = 'ok' | 'warn' | 'fail';

export interface Check {
  readonly name: string;
  readonly status: CheckStatus;
  readonly detail: string;
}

export interface DoctorOptions {
  readonly cwd: string;
  readonly port: number;
  readonly dbPath?: string | undefined;
  /** Hooks silent for longer than this are reported. Defaults to 24 hours. */
  readonly silentAfterMs?: number;
}

export interface DoctorReport {
  readonly checks: readonly Check[];
  readonly ok: boolean;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function readSettings(path: string): SettingsDocument | 'missing' | 'invalid' {
  if (!existsSync(path)) return 'missing';
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return 'invalid';
    return parsed as SettingsDocument;
  } catch {
    return 'invalid';
  }
}

function probePort(port: number, host: string): Promise<'free' | 'in-use'> {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host });
    const finish = (result: 'free' | 'in-use'): void => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(500);
    socket.once('connect', () => finish('in-use'));
    socket.once('timeout', () => finish('free'));
    socket.once('error', () => finish('free'));
  });
}

async function probeGorilla(port: number, host: string): Promise<boolean> {
  try {
    const response = await fetch(`http://${host}:${port}/health`, {
      signal: AbortSignal.timeout(1_000),
    });
    const body = (await response.json()) as { status?: string };
    return body.status === 'ok';
  } catch {
    return false;
  }
}

function checkSettings(cwd: string): Check[] {
  const checks: Check[] = [];

  // Must compute the expected document exactly as `init` writes it, bridge
  // included, or every correctly configured project reports as out of date.
  const bridgePath = requiresBridge() ? join(cwd, '.claude', BRIDGE_SCRIPT_NAME) : undefined;

  const localPath = settingsPathFor(cwd, false);
  const sharedPath = settingsPathFor(cwd, true);

  const local = readSettings(localPath);
  const shared = readSettings(sharedPath);

  const documents = [
    { path: localPath, doc: local },
    { path: sharedPath, doc: shared },
  ].filter((entry) => entry.doc !== 'missing');

  if (documents.length === 0) {
    checks.push({
      name: 'hook configuration',
      status: 'fail',
      detail: `No settings file found. Run \`gorilla init\` in ${cwd}.`,
    });
    return checks;
  }

  for (const { path, doc } of documents) {
    if (doc === 'invalid') {
      checks.push({
        name: 'hook configuration',
        status: 'fail',
        detail: `${path} is not valid JSON.`,
      });
      continue;
    }
    if (doc === 'missing') continue;

    // Against the base the settings themselves use, not against ours. A
    // project deliberately serving elsewhere is not out of date, and sending
    // its operator to `init` would be answering a question nobody asked.
    const current = isUpToDate(doc, {
      baseUrl: configuredBaseUrl(doc) ?? DEFAULT_HOOK_BASE_URL,
      ...(bridgePath === undefined ? {} : { bridgePath }),
    });
    checks.push({
      name: 'hook configuration',
      status: current ? 'ok' : 'warn',
      detail: current
        ? `${path} registers all ${HOOK_DEFINITIONS.length} hooks.`
        : `${path} is out of date with the current hook list. Run \`gorilla init\`.`,
    });
  }

  return checks;
}

interface DeliveryRow {
  event_name: string;
  n: number;
  last_at: number;
}

function checkDeliveries(dbPath: string, silentAfterMs: number): Check[] {
  if (!existsSync(dbPath)) {
    return [
      {
        name: 'event deliveries',
        status: 'warn',
        detail: `No database at ${dbPath} yet. It is created on the first event.`,
      },
    ];
  }

  const handle = openDatabase({ path: dbPath, migrate: false });

  try {
    const rows = handle.sqlite
      .prepare(
        'SELECT event_name, COUNT(*) AS n, MAX(received_at) AS last_at FROM events GROUP BY event_name',
      )
      .all() as DeliveryRow[];

    const seen = new Map(rows.map((row) => [row.event_name, row]));
    const cutoff = Date.now() - silentAfterMs;

    const silent = HOOK_DEFINITIONS.filter((definition) => {
      const row = seen.get(definition.event);
      return row === undefined || row.last_at < cutoff;
    }).map((definition) => definition.event);

    const total = rows.reduce((sum, row) => sum + row.n, 0);

    const checks: Check[] = [
      {
        name: 'event deliveries',
        status: total > 0 ? 'ok' : 'warn',
        detail:
          total > 0
            ? `${total} event(s) received across ${rows.length} event type(s).`
            : 'No events received yet.',
      },
    ];

    if (silent.length > 0) {
      checks.push({
        name: 'silent hooks',
        // A warning, not a failure: several of these only fire under
        // conditions a short session never reaches, such as PreCompact.
        status: 'warn',
        detail: `No delivery in the last ${Math.round(silentAfterMs / 3_600_000)}h from: ${silent.join(', ')}`,
      });
    } else {
      checks.push({
        name: 'silent hooks',
        status: 'ok',
        detail: 'Every configured hook has delivered recently.',
      });
    }

    const size = statSync(dbPath).size;
    checks.push({
      name: 'database',
      status: 'ok',
      detail: `${dbPath} (${(size / 1_048_576).toFixed(2)} MB)`,
    });

    return checks;
  } catch (error) {
    return [
      {
        name: 'event deliveries',
        status: 'fail',
        detail: `Could not read ${dbPath}: ${(error as Error).message}`,
      },
    ];
  } finally {
    handle.close();
  }
}

async function checkTranscripts(dbPath: string): Promise<Check> {
  if (!existsSync(dbPath)) {
    return { name: 'transcript format', status: 'warn', detail: 'No runs recorded yet.' };
  }

  const handle = openDatabase({ path: dbPath, migrate: false });

  try {
    const rows = handle.sqlite
      .prepare(
        'SELECT transcript_path FROM runs WHERE transcript_path IS NOT NULL ORDER BY started_at DESC LIMIT 3',
      )
      .all() as { transcript_path: string }[];

    if (rows.length === 0) {
      return { name: 'transcript format', status: 'warn', detail: 'No transcript paths recorded.' };
    }

    const drifted: string[] = [];
    let checked = 0;

    for (const row of rows) {
      const summary = await readTranscript(row.transcript_path);
      if (!summary.exists) continue;
      checked += 1;

      const unknown = Object.keys(summary.drift.unknownTypes);
      if (unknown.length > 0) drifted.push(...unknown);
    }

    if (checked === 0) {
      return {
        name: 'transcript format',
        status: 'warn',
        detail: 'Recorded transcript paths no longer exist on disk.',
      };
    }

    const unique = [...new Set(drifted)];
    return {
      name: 'transcript format',
      // Drift is a warning: the transcript is an enrichment source and every
      // core feature works without it (doc 02, R6).
      status: unique.length > 0 ? 'warn' : 'ok',
      detail:
        unique.length > 0
          ? `Unrecognised record types in ${checked} transcript(s): ${unique.join(', ')}. The parser may need updating.`
          : `${checked} transcript(s) parsed with no unrecognised record types.`,
    };
  } catch (error) {
    return {
      name: 'transcript format',
      status: 'warn',
      detail: `Could not check transcripts: ${(error as Error).message}`,
    };
  } finally {
    handle.close();
  }
}

/**
 * Whether a halt would reach the operator.
 *
 * A warning rather than a failure: a board watched by somebody sitting in front
 * of it needs no notifier. It is worth saying out loud all the same, because
 * the operator who most needs this is the one who will not find out it was
 * missing until a night has already been lost.
 */
function checkNotify(): Check {
  const command = (process.env[NOTIFY_ENV] ?? '').trim();

  return {
    name: 'halt notification',
    status: command === '' ? 'warn' : 'ok',
    detail:
      command === ''
        ? `${NOTIFY_ENV} is not set: an overnight halt will wait silently until you look.`
        : `A halt runs: ${command}`,
  };
}

/**
 * Whether the hooks point at the board (doc 07).
 *
 * The quietest way to lose everything: `init` writes hooks naming one port and
 * `serve --port` starts the board on another. Both halves are individually
 * correct - all seventeen hooks registered, the server up and answering - and
 * every event is dropped in between. The board then looks running and empty,
 * which is what a board looks like before anything has happened.
 *
 * That is why this compares the two facts against each other. Checking the
 * settings against `DEFAULT_HOOK_BASE_URL` and the port against nothing is how
 * the mismatch stayed invisible in this report.
 *
 * Severity follows what is actually known. With a board confirmed on the port,
 * events are demonstrably going nowhere and this fails. With nothing listening,
 * the port is the operator's hypothesis rather than an observation, so it warns.
 */
/**
 * Boards that are really worktrees (T67).
 *
 * A card's session used to report its worktree as its cwd and be given a board
 * of its own. That is fixed going forward, but the boards it already made are
 * still there, holding runs that belong to the project.
 *
 * Reported rather than deleted. Those rows have runs and events hanging off
 * them, and a cleanup that got the reattachment wrong would silently move one
 * card's history onto another - worse than a board list with some junk in it.
 */
/** Where board events are posted, if anywhere (T45). */
function checkWebhook(): Check {
  const url = (process.env[WEBHOOK_ENV] ?? '').trim();

  if (url === '') {
    return {
      name: 'webhook',
      status: 'ok',
      detail: `${WEBHOOK_ENV} is not set. Nothing is posted anywhere, which is the default.`,
    };
  }

  // A url the delivery will refuse is worth failing on here rather than at
  // 3am, where it appears as a webhook that silently never fires.
  return isDeliverable(url)
    ? { name: 'webhook', status: 'ok', detail: `Board events are posted to ${url}` }
    : {
        name: 'webhook',
        status: 'fail',
        detail: `${WEBHOOK_ENV} is not an http or https url, so nothing will ever be posted: ${url}`,
      };
}

function checkPhantomBoards(dbPath: string): Check {
  if (!existsSync(dbPath)) {
    return { name: 'boards', status: 'ok', detail: 'No board database yet.' };
  }

  const handle = openDatabase({ path: dbPath, migrate: false });

  try {
    const boards = handle.sqlite.prepare('SELECT name, cwd FROM boards').all() as {
      name: string;
      cwd: string;
    }[];

    const phantom = boards.filter((board) => owningBoardCwd(board.cwd) !== board.cwd);

    return {
      name: 'boards',
      status: phantom.length === 0 ? 'ok' : 'warn',
      detail:
        phantom.length === 0
          ? `${String(boards.length)} board(s), each a project directory.`
          : `${String(phantom.length)} of ${String(boards.length)} board(s) are card worktrees that were registered as boards before this was fixed: ${phantom.map((board) => board.name).join(', ')}. They hold runs that belong to the project. Nothing removes them automatically, because a wrong reattachment would move one card's history onto another.`,
    };
  } finally {
    handle.close();
  }
}

function checkHookTarget(cwd: string, port: number, serverPresent: boolean): Check[] {
  const checks: Check[] = [];

  for (const path of [settingsPathFor(cwd, false), settingsPathFor(cwd, true)]) {
    const doc = readSettings(path);
    if (doc === 'missing' || doc === 'invalid') continue;

    const target = assessHookTarget({ doc, port, settingsPath: path, host: DEFAULT_HOST });
    if (target.verdict === 'unconfigured') continue;

    checks.push({
      name: 'hook target',
      status: target.verdict === 'agree' ? 'ok' : serverPresent ? 'fail' : 'warn',
      detail: target.detail,
    });
  }

  return checks;
}

export async function runDoctor(options: DoctorOptions): Promise<DoctorReport> {
  const dbPath = resolveDatabasePath(options.dbPath);
  const silentAfterMs = options.silentAfterMs ?? DAY_MS;

  const checks: Check[] = [...checkSettings(options.cwd)];

  const portState = await probePort(options.port, DEFAULT_HOST);
  if (portState === 'in-use') {
    const isGorilla = await probeGorilla(options.port, DEFAULT_HOST);
    checks.push({
      name: 'server',
      status: isGorilla ? 'ok' : 'fail',
      detail: isGorilla
        ? `Gorilla is serving on ${DEFAULT_HOST}:${options.port}.`
        : `Port ${options.port} is in use by something that is not Gorilla.`,
    });
  } else {
    checks.push({
      name: 'server',
      status: 'warn',
      detail: `Not running. Port ${options.port} is free; start it with \`gorilla serve\`.`,
    });
  }

  checks.push(...checkHookTarget(options.cwd, options.port, portState === 'in-use'));

  checks.push(checkNotify());
  checks.push(checkWebhook());
  checks.push(checkPhantomBoards(dbPath));
  checks.push(...checkDeliveries(dbPath, silentAfterMs));
  checks.push(await checkTranscripts(dbPath));

  return { checks, ok: !checks.some((check) => check.status === 'fail') };
}

const LABEL: Record<CheckStatus, string> = {
  ok: 'ok  ',
  warn: 'warn',
  fail: 'FAIL',
};

export function formatReport(report: DoctorReport): string {
  const lines = report.checks.map(
    (check) => `[${LABEL[check.status]}] ${check.name}: ${check.detail}`,
  );

  lines.push('');
  lines.push(report.ok ? 'No blocking problems found.' : 'Configuration problems found.');

  return lines.join('\n');
}

export const doctorCommand: Command = {
  name: 'doctor',
  summary: 'Check the installation and report what the board cannot see',
  async run(args: readonly string[]): Promise<CommandResult> {
    const portIndex = args.indexOf('--port');
    const port = portIndex === -1 ? DEFAULT_PORT : Number(args[portIndex + 1]);

    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      return { exitCode: 1, stdout: '', stderr: '--port expects a port number' };
    }

    const dirIndex = args.indexOf('--dir');
    const cwd = dirIndex === -1 ? process.cwd() : (args[dirIndex + 1] ?? process.cwd());

    const report = await runDoctor({ cwd, port });

    return {
      exitCode: report.ok ? 0 : 1,
      stdout: formatReport(report),
      stderr: '',
    };
  },
};
