import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  buildArgs,
  composePrompt,
  denyRulesFor,
  renderCardContext,
  settingsOverlay,
} from '../src/server/launcher/args.js';
import { LaunchRegistry, launch } from '../src/server/launcher/launcher.js';
import { EMPTY_GUARDRAILS, type GuardrailSet } from '../src/server/cards/guardrails.js';

let dir: string;

const guardrails: GuardrailSet = {
  scope: ['src/ingest/'],
  prohibit: ['src/db/schema.ts', 'Bash(git push *)', 'be careless'],
  allowTools: ['Read', 'Edit'],
  verify: 'npm test',
  maxTurns: 20,
};

/**
 * A stand-in for the `claude` binary. Real launches cost tokens and are
 * non-deterministic; what needs testing here is supervision, not the agent.
 */
function fakeClaude(script: string): string {
  const path = join(dir, `fake-claude-${Math.random().toString(36).slice(2)}.sh`);
  writeFileSync(path, `#!/usr/bin/env bash\n${script}\n`, 'utf8');
  chmodSync(path, 0o755);
  return path;
}

const baseOptions = {
  cwd: process.cwd(),
  title: 'Test card',
  body: 'Do the thing.',
  guardrails: EMPTY_GUARDRAILS,
  goalCondition: 'the tests pass',
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gorilla-launcher-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('composePrompt', () => {
  it('prefers the goal condition', () => {
    expect(composePrompt({ goalCondition: 'x passes', guardrails: EMPTY_GUARDRAILS })).toBe(
      '/goal x passes',
    );
  });

  it('falls back to the prompt when there is no condition', () => {
    expect(
      composePrompt({ goalCondition: null, prompt: 'do the thing', guardrails: EMPTY_GUARDRAILS }),
    ).toBe('do the thing');
  });
});

describe('buildArgs', () => {
  it('passes the card model, effort, permission mode and tools', () => {
    const args = buildArgs({
      goalCondition: 'the tests pass',
      guardrails,
      agentModel: 'sonnet',
      agentEffort: 'high',
      permissionMode: 'acceptEdits',
      contextFilePath: '/tmp/ctx.md',
      settingsPath: '/tmp/settings.json',
    });

    expect(args).toEqual([
      '-p',
      '/goal the tests pass',
      '--output-format',
      'stream-json',
      '--verbose',
      '--model',
      'sonnet',
      '--effort',
      'high',
      '--permission-mode',
      'acceptEdits',
      '--allowedTools',
      'Read,Edit',
      '--append-system-prompt-file',
      '/tmp/ctx.md',
      '--settings',
      '/tmp/settings.json',
    ]);
  });

  it('omits every optional flag when the card sets nothing', () => {
    const args = buildArgs({ goalCondition: 'x', guardrails: EMPTY_GUARDRAILS });

    expect(args).not.toContain('--model');
    expect(args).not.toContain('--allowedTools');
    expect(args).not.toContain('--settings');
  });

  it('always requests the stream format, since binding depends on it', () => {
    const args = buildArgs({ goalCondition: 'x', guardrails: EMPTY_GUARDRAILS });
    expect(args).toContain('--output-format');
    expect(args).toContain('stream-json');
  });
});

describe('deny rules', () => {
  it('derives rules only from expressible prohibitions', () => {
    const rules = denyRulesFor(guardrails);

    expect(rules).toContain('Edit(src/db/schema.ts)');
    expect(rules).toContain('Bash(git push *)');
    // An advisory prohibition must not become a rule that matches nothing: a
    // rule that looks like protection but is not is worse than no rule.
    expect(rules.join(' ')).not.toContain('careless');
  });

  it('produces no overlay when nothing is expressible', () => {
    expect(settingsOverlay({ ...EMPTY_GUARDRAILS, prohibit: ['be nice'] })).toEqual({});
  });

  it('puts rules under permissions.deny', () => {
    expect(settingsOverlay(guardrails)).toEqual({
      permissions: { deny: ['Edit(src/db/schema.ts)', 'Bash(git push *)'] },
    });
  });
});

describe('card context', () => {
  it('marks each constraint with whether it is enforced', () => {
    const context = renderCardContext({ title: 'T', body: 'B', guardrails });

    expect(context).toContain('# Card: T');
    expect(context).toContain('Do not src/db/schema.ts (hard)');
    expect(context).toContain('Do not be careless (advisory)');
    expect(context).toContain('Only touch src/ingest/ (advisory)');
  });

  it('includes accepted entries and previous runs when present', () => {
    const context = renderCardContext({
      title: 'T',
      body: '',
      guardrails: EMPTY_GUARDRAILS,
      acceptedEntries: ['The schema is append-only'],
      previousRuns: ['Run 1 added the endpoint'],
    });

    expect(context).toContain('The schema is append-only');
    expect(context).toContain('Run 1 added the endpoint');
  });

  it('omits empty sections rather than leaving headings', () => {
    const context = renderCardContext({ title: 'T', body: '', guardrails: EMPTY_GUARDRAILS });
    expect(context).not.toContain('## Constraints');
    expect(context).not.toContain('## Previous runs');
  });
});

describe('supervision', () => {
  it('binds the session id from the first event without inference', async () => {
    const executable = fakeClaude(`
echo '{"type":"system","subtype":"init","session_id":"sess-abc","model":"sonnet"}'
echo '{"type":"assistant","session_id":"sess-abc"}'
echo '{"type":"result","session_id":"sess-abc"}'
`);

    const seen: string[] = [];
    const running = launch({ ...baseOptions, executable, onSessionId: (id) => seen.push(id) });
    const result = await running.result;

    expect(result.outcome).toBe('completed');
    expect(result.sessionId).toBe('sess-abc');
    // Reported once, on the first event that carries it.
    expect(seen).toEqual(['sess-abc']);
    expect(result.events).toHaveLength(3);
  });

  it('counts api_retry events', async () => {
    const executable = fakeClaude(`
echo '{"type":"system","subtype":"init","session_id":"s"}'
echo '{"type":"system","subtype":"api_retry","attempt":1}'
echo '{"type":"system","subtype":"api_retry","attempt":2}'
`);

    expect((await launch({ ...baseOptions, executable }).result).retries).toBe(2);
  });

  it('reports a non-zero exit as failed', async () => {
    const executable = fakeClaude(`echo '{"type":"system","session_id":"s"}'\nexit 3`);
    const result = await launch({ ...baseOptions, executable }).result;

    expect(result.outcome).toBe('failed');
    expect(result.exitCode).toBe(3);
  });

  it('reports cancellation as cancelled, not as a failure', async () => {
    const executable = fakeClaude(`
echo '{"type":"system","subtype":"init","session_id":"s"}'
sleep 30
`);

    const running = launch({ ...baseOptions, executable });
    // Let the process start before signalling it.
    await new Promise((resolve) => setTimeout(resolve, 300));
    running.cancel();

    const result = await running.result;
    expect(result.outcome).toBe('cancelled');
    expect(result.sessionId).toBe('s');
  });

  it('terminates the child on cancellation rather than leaking it', async () => {
    const executable = fakeClaude(`echo '{"type":"system","session_id":"s"}'\nsleep 30`);

    const running = launch({ ...baseOptions, executable });
    await new Promise((resolve) => setTimeout(resolve, 300));
    const pid = running.pid;
    running.cancel();
    await running.result;

    expect(pid).toBeDefined();
    // Signal 0 probes for existence; the process must be gone.
    expect(() => process.kill(pid ?? 0, 0)).toThrow();
  });

  it('survives a malformed line in the stream', async () => {
    const executable = fakeClaude(`
echo 'not json at all'
echo '{"type":"system","subtype":"init","session_id":"s"}'
echo '{ truncated'
`);

    const result = await launch({ ...baseOptions, executable }).result;

    expect(result.outcome).toBe('completed');
    expect(result.sessionId).toBe('s');
    expect(result.events).toHaveLength(1);
  });

  it('reports a missing executable as failed rather than throwing', async () => {
    const result = await launch({
      ...baseOptions,
      executable: join(dir, 'does-not-exist'),
    }).result;

    expect(result.outcome).toBe('failed');
    expect(result.sessionId).toBeNull();
  });

  it('passes the card id in the environment', async () => {
    const marker = join(dir, 'env.txt');
    const executable = fakeClaude(`echo "$GORILLA_CARD_ID" > ${marker}`);

    await launch({ ...baseOptions, executable, cardId: 'card-42' }).result;
    expect(readFileSync(marker, 'utf8').trim()).toBe('card-42');
  });

  it('writes the settings overlay to a temporary file, never the project', async () => {
    const marker = join(dir, 'args.txt');
    const executable = fakeClaude(`echo "$@" > ${marker}`);

    await launch({ ...baseOptions, executable, guardrails }).result;
    const args = readFileSync(marker, 'utf8');

    expect(args).toContain('--settings');
    // A card's restrictions must not leak into the repository's own settings.
    expect(args).not.toContain('.claude/settings');
  });
});

describe('LaunchRegistry', () => {
  it('forgets a launch once it finishes', async () => {
    const registry = new LaunchRegistry();
    const executable = fakeClaude(`echo '{"type":"result"}'`);

    const running = registry.track(launch({ ...baseOptions, executable }));
    await running.result;
    // The finally handler runs on a microtask.
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(registry.size).toBe(0);
  });

  it('cancels everything still running, so shutdown leaves no orphans', async () => {
    const registry = new LaunchRegistry();
    const executable = fakeClaude(`echo '{"type":"system","session_id":"s"}'\nsleep 30`);

    const first = registry.track(launch({ ...baseOptions, executable }));
    const second = registry.track(launch({ ...baseOptions, executable }));
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(registry.size).toBe(2);
    await registry.cancelAll();

    expect((await first.result).outcome).toBe('cancelled');
    expect((await second.result).outcome).toBe('cancelled');
  });
});
