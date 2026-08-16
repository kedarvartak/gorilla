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

    const current = isUpToDate(doc, {
      baseUrl: DEFAULT_HOOK_BASE_URL,
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
