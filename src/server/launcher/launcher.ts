import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

import { buildArgs, renderCardContext, settingsOverlay, type LaunchSpec } from './args.js';
import type { GuardrailSet } from '../cards/guardrails.js';

/**
 * Spawns and supervises `claude -p` for a dispatched card (doc 07 section 3).
 *
 * Two obligations beyond starting a process:
 *
 * - **Bind without inference.** The session id arrives in the first
 *   `system/init` event, so a launched card never needs the guesswork that
 *   attached mode does.
 * - **Leave nothing behind.** A board that exits owing an orphaned `claude`
 *   process has taken over the machine, so cancellation and shutdown both
 *   terminate the child.
 */

export interface StreamEventPayload {
  readonly type: string;
  readonly subtype?: string;
  readonly session_id?: string;
  readonly [key: string]: unknown;
}

export interface LaunchOptions {
  readonly cwd: string;
  readonly title: string;
  readonly body: string;
  readonly guardrails: GuardrailSet;
  readonly goalCondition?: string | null;
  readonly prompt?: string | null;
  readonly agentModel?: string | null;
  readonly agentEffort?: string | null;
  readonly permissionMode?: string | null;
  readonly cardId?: string | null;
  readonly acceptedEntries?: readonly string[];
  readonly previousRuns?: readonly string[];
  /** Overridable for tests. Defaults to `claude`. */
  readonly executable?: string;
  readonly onEvent?: (event: StreamEventPayload) => void;
  readonly onSessionId?: (sessionId: string) => void;
  readonly onStderr?: (line: string) => void;
}

export type LaunchOutcome = 'completed' | 'failed' | 'cancelled';

export interface LaunchResult {
  readonly outcome: LaunchOutcome;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly sessionId: string | null;
  readonly events: readonly StreamEventPayload[];
  readonly retries: number;
  readonly stderr: string;
}

export interface RunningLaunch {
  readonly result: Promise<LaunchResult>;
  /** SIGTERM: aborts the turn, runs SessionEnd hooks, exits 143. */
  cancel(): void;
  readonly pid: number | undefined;
}

function writeLaunchFiles(options: LaunchOptions): {
  contextPath: string;
  settingsPath: string | null;
} {
  const dir = mkdtempSync(join(tmpdir(), 'gorilla-launch-'));

  const contextPath = join(dir, 'card-context.md');
  writeFileSync(
    contextPath,
    renderCardContext({
      title: options.title,
      body: options.body,
      guardrails: options.guardrails,
      ...(options.acceptedEntries === undefined
        ? {}
        : { acceptedEntries: options.acceptedEntries }),
      ...(options.previousRuns === undefined ? {} : { previousRuns: options.previousRuns }),
    }),
    'utf8',
  );

  const overlay = settingsOverlay(options.guardrails);
  if (Object.keys(overlay).length === 0) return { contextPath, settingsPath: null };

  const settingsPath = join(dir, 'gorilla-launch-settings.json');
  writeFileSync(settingsPath, JSON.stringify(overlay, null, 2), 'utf8');

  return { contextPath, settingsPath };
}

export function launch(options: LaunchOptions): RunningLaunch {
  const { contextPath, settingsPath } = writeLaunchFiles(options);

  const spec: LaunchSpec = {
    goalCondition: options.goalCondition ?? null,
    prompt: options.prompt ?? null,
    guardrails: options.guardrails,
    agentModel: options.agentModel ?? null,
    agentEffort: options.agentEffort ?? null,
    permissionMode: options.permissionMode ?? null,
    contextFilePath: contextPath,
    settingsPath,
    resumeSessionId: null,
  };

  const child = spawn(options.executable ?? 'claude', buildArgs(spec), {
    cwd: options.cwd,
    env: {
      ...process.env,
      ...(options.cardId === null || options.cardId === undefined
        ? {}
        : { GORILLA_CARD_ID: options.cardId }),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    // Its own process group, so cancellation can signal the whole tree.
    // Signalling the child alone leaves its descendants running and holding
    // the stdout pipe open, which is both an orphan and a hang.
    detached: true,
  });

  const events: StreamEventPayload[] = [];
  let sessionId: string | null = null;
  let retries = 0;
  let cancelled = false;
  let stderr = '';

  const stdout = createInterface({ input: child.stdout, crlfDelay: Infinity });

  stdout.on('line', (line) => {
    const trimmed = line.trim();
    if (trimmed === '') return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      // A partial or non-JSON line is not worth failing a run over.
      return;
    }

    if (typeof parsed !== 'object' || parsed === null) return;
    const event = parsed as StreamEventPayload;
    events.push(event);

    if (sessionId === null && typeof event.session_id === 'string') {
      sessionId = event.session_id;
      options.onSessionId?.(sessionId);
    }
    if (event.type === 'system' && event.subtype === 'api_retry') retries += 1;

    options.onEvent?.(event);
  });

  child.stderr.on('data', (chunk: Buffer) => {
    const text = chunk.toString();
    stderr += text;
    for (const line of text.split('\n')) {
      if (line.trim() !== '') options.onStderr?.(line);
    }
  });

  const result = new Promise<LaunchResult>((resolve) => {
    const finish = (exitCode: number | null, signal: NodeJS.Signals | null): void => {
      stdout.close();

      // 143 is SIGTERM's conventional exit code and is what a cancelled run
      // looks like, so it is reported as cancelled rather than as a failure.
      const outcome: LaunchOutcome =
        cancelled || signal === 'SIGTERM' || exitCode === 143
          ? 'cancelled'
          : exitCode === 0
            ? 'completed'
            : 'failed';

      resolve({ outcome, exitCode, signal, sessionId, events, retries, stderr });
    };

    child.on('close', finish);
    child.on('error', (error) => {
      stderr += `${error.message}\n`;
      finish(null, null);
    });
  });

  return {
    result,
    pid: child.pid,
    cancel: () => {
      cancelled = true;
      if (child.exitCode !== null || child.signalCode !== null) return;

      // Negative pid targets the process group. SIGTERM lets Claude Code abort
      // its turn and run SessionEnd hooks (doc 07 section 3); the group makes
      // sure nothing it spawned survives.
      const pid = child.pid;
      if (pid !== undefined) {
        try {
          process.kill(-pid, 'SIGTERM');
          return;
        } catch {
          // The group may already be gone, or the platform may not support it.
        }
      }
      child.kill('SIGTERM');
    },
  };
}

/**
 * Tracks running launches so board shutdown can terminate them.
 *
 * Without this, stopping the board leaves `claude` processes running against
 * the operator's repository with nothing watching them.
 */
export class LaunchRegistry {
  readonly #running = new Set<RunningLaunch>();

  get size(): number {
    return this.#running.size;
  }

  track(running: RunningLaunch): RunningLaunch {
    this.#running.add(running);
    void running.result.finally(() => this.#running.delete(running));
    return running;
  }

  async cancelAll(): Promise<void> {
    const pending = [...this.#running];
    for (const running of pending) running.cancel();
    await Promise.allSettled(pending.map((running) => running.result));
  }
}
