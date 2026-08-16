import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import Fastify, { type FastifyInstance } from 'fastify';

import { readTailWindow, readTranscript } from '../server/transcript/index.js';
import {
  createNonce,
  gradeAnswer,
  type HookObservation,
  type ProbeFindings,
  type ProbeNonce,
} from './compaction.js';

const run = promisify(execFile);

/**
 * Drives a real Claude Code session against a purpose-built hook receiver.
 *
 * Deliberately separate from the board server: the probe answers questions
 * about Claude Code, and mixing it into the product server would make a
 * negative result ambiguous between "Claude Code does not do this" and
 * "Gorilla has a bug".
 *
 * Both handler types are registered for the same events in the same settings
 * file, so any difference between them is a property of Claude Code and not of
 * how the probe was configured. That comparison is what found the SessionStart
 * result; without it the first run reported a false negative.
 */

export interface ProbeOptions {
  readonly cwd?: string;
  readonly port?: number;
  readonly timeoutMs?: number;
  readonly log?: (message: string) => void;
}

const OBSERVED_EVENTS = ['SessionStart', 'PreCompact', 'PostCompact', 'Stop', 'SessionEnd'];

interface ProbeServer {
  readonly observations: HookObservation[];
  readonly state: {
    preCompactFired: boolean;
    transcriptReadable: boolean;
    transcriptTailChars: number;
    sessionStartCompactFired: boolean;
  };
  stop(): Promise<void>;
}

async function startProbeServer(port: number, nonce: ProbeNonce): Promise<ProbeServer> {
  const app: FastifyInstance = Fastify({ logger: false });
  const observations: HookObservation[] = [];
  const state = {
    preCompactFired: false,
    transcriptReadable: false,
    transcriptTailChars: 0,
    sessionStartCompactFired: false,
  };

  app.post<{ Params: { transport: string; event: string } }>(
    '/hooks/:transport/:event',
    async (request, reply) => {
      const { transport, event } = request.params;
      const payload = (request.body ?? {}) as Record<string, unknown>;

      const source = typeof payload['source'] === 'string' ? payload['source'] : null;
      const trigger =
        typeof payload['trigger_reason'] === 'string' ? payload['trigger_reason'] : null;
      const transcriptPath =
        typeof payload['transcript_path'] === 'string' ? payload['transcript_path'] : null;

      observations.push({
        event: `${transport}:${event}`,
        matcher: source ?? trigger,
        at: Date.now(),
      });

      // Q1: is the about-to-be-discarded window readable right now?
      if (event === 'PreCompact' && transcriptPath !== null && !state.preCompactFired) {
        state.preCompactFired = true;
        const summary = await readTranscript(transcriptPath);
        const tail = await readTailWindow(transcriptPath, 5_000);
        state.transcriptReadable = summary.exists && summary.recordCount > 0;
        state.transcriptTailChars = tail.length;
      } else if (event === 'PreCompact') {
        state.preCompactFired = true;
      }

      // Q2
      if (event === 'SessionStart' && source === 'compact') {
        state.sessionStartCompactFired = true;
      }

      // Q3: injected on every SessionStart, so the nonce is present whichever
      // source value fires.
      if (event === 'SessionStart') {
        return reply.code(200).send({
          hookSpecificOutput: {
            hookEventName: 'SessionStart',
            additionalContext: nonce.injection,
          },
        });
      }

      return reply.code(200).send({});
    },
  );

  await app.listen({ port, host: '127.0.0.1' });

  return { observations, state, stop: () => app.close() };
}

/**
 * A command hook that forwards to the board over HTTP and relays the response.
 *
 * Needed because HTTP hooks do not receive every event (see the findings
 * document). Written with curl and no jq so it has no dependency beyond what a
 * developer machine already has.
 */
function bridgeScript(port: number): string {
  return `#!/usr/bin/env bash
# Gorilla probe bridge: forward the hook payload to the board and relay the reply.
event="$1"
payload=$(cat)
response=$(printf '%s' "$payload" | curl -sS -m 30 -X POST \\
  -H 'content-type: application/json' \\
  --data-binary @- "http://127.0.0.1:${port}/hooks/command/$event" 2>/dev/null)
# Relay the board's JSON decision on stdout, which is where Claude Code reads it.
printf '%s' "$response"
exit 0
`;
}

function writeProbeProject(cwd: string, port: number): void {
  const claudeDir = join(cwd, '.claude');
  mkdirSync(claudeDir, { recursive: true });

  const bridgePath = join(claudeDir, 'bridge.sh');
  writeFileSync(bridgePath, bridgeScript(port), 'utf8');
  chmodSync(bridgePath, 0o755);

  const hooks = Object.fromEntries(
    OBSERVED_EVENTS.map((event) => [
      event,
      [
        {
          hooks: [
            // Both transports, same event, same file. Any difference between
            // them is Claude Code's behaviour, not the probe's configuration.
            { type: 'command', command: `${bridgePath} ${event}`, timeout: 60 },
            { type: 'http', url: `http://127.0.0.1:${port}/hooks/http/${event}`, timeout: 60 },
          ],
        },
      ],
    ]),
  );

  writeFileSync(
    join(claudeDir, 'settings.local.json'),
    `${JSON.stringify({ hooks }, null, 2)}\n`,
    'utf8',
  );
  writeFileSync(join(cwd, 'NOTES.md'), 'Scratch project for the Gorilla compaction probe.\n');
}

interface ClaudeResult {
  readonly sessionId: string | null;
  readonly text: string;
}

async function claude(
  args: readonly string[],
  cwd: string,
  timeoutMs: number,
): Promise<ClaudeResult> {
  const { stdout } = await run('claude', [...args, '--output-format', 'json'], {
    cwd,
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
  });

  try {
    const parsed = JSON.parse(stdout) as { session_id?: string; result?: string };
    return { sessionId: parsed.session_id ?? null, text: parsed.result ?? '' };
  } catch {
    return { sessionId: null, text: stdout };
  }
}

/**
 * Compaction is triggered with `/compact` rather than by filling the context
 * window: both reach the same code, and forcing a real auto-compaction costs
 * hours and a very large number of tokens for the same answers. T10 confirms
 * the auto path during the verification run.
 */
export async function runProbe(options: ProbeOptions = {}): Promise<ProbeFindings> {
  const port = options.port ?? 4488;
  const timeoutMs = options.timeoutMs ?? 300_000;
  const log = options.log ?? ((): void => undefined);
  const cwd = options.cwd ?? mkdtempSync(join(tmpdir(), 'gorilla-probe-'));

  const nonce = createNonce();
  writeProbeProject(cwd, port);

  const server = await startProbeServer(port, nonce);

  try {
    log('1/3 starting a session');
    const first = await claude(['-p', 'Reply with the single word: ready'], cwd, timeoutMs);

    if (first.sessionId === null) {
      throw new Error(`Could not determine a session id. Output was: ${first.text.slice(0, 400)}`);
    }
    log(`    session ${first.sessionId}`);

    log('2/3 compacting');
    await claude(['-p', '/compact', '--resume', first.sessionId], cwd, timeoutMs);

    log('3/3 asking for the code');
    const answer = await claude(
      [`-p`, nonce.question, '--resume', first.sessionId],
      cwd,
      timeoutMs,
    );

    return {
      preCompactFired: server.state.preCompactFired,
      transcriptReadableAtPreCompact: server.state.transcriptReadable,
      transcriptTailChars: server.state.transcriptTailChars,
      sessionStartCompactFired: server.state.sessionStartCompactFired,
      injectionVerdict: gradeAnswer(answer.text, nonce),
      nonce: nonce.value,
      answer: answer.text,
      observations: server.observations,
    };
  } finally {
    await server.stop();
  }
}
