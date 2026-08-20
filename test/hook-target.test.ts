import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { assessHookTarget, hookTargets, portOf } from '../src/hooks/target.js';
import { hookTargetWarning } from '../src/hooks/warn.js';
import type { SettingsDocument } from '../src/hooks/settings.js';

/**
 * Hooks pointing at a board that is not there (doc 07).
 *
 * The quietest way to lose everything. `init` writes hooks naming one port,
 * `serve --port` starts the board on another, and both halves are individually
 * correct while every event is dropped in between. What the operator sees is a
 * board that is running and empty, which is what a board looks like before
 * anything has happened.
 */

const settings = (url: string): SettingsDocument => ({
  hooks: {
    PreToolUse: [{ matcher: '*', hooks: [{ type: 'http', url }] }],
  },
});

describe('finding where the hooks point', () => {
  it('reads an http hook', () => {
    const found = hookTargets(settings('http://127.0.0.1:4300/hooks/PreToolUse'));

    expect(found).toHaveLength(1);
    expect(found[0]?.event).toBe('PreToolUse');
  });

  it('reads a bridged command hook', () => {
    // A bridged event forwards through a shell script and records the endpoint
    // as `gorillaUrl`. Without that it would look unconfigured, and the event
    // most worth repairing after - SessionStart - is the bridged one.
    const doc: SettingsDocument = {
      hooks: {
        SessionStart: [
          {
            hooks: [
              {
                type: 'command',
                command: '/tmp/gorilla-bridge.sh SessionStart',
                gorillaUrl: 'http://127.0.0.1:4300/hooks/SessionStart',
              },
            ],
          },
        ],
      },
    };

    expect(hookTargets(doc)).toHaveLength(1);
  });

  it('ignores hooks that are not ours', () => {
    const doc: SettingsDocument = {
      hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'make lint' }] }] },
    };

    expect(hookTargets(doc)).toHaveLength(0);
  });

  it('survives a settings document with no hooks at all', () => {
    expect(hookTargets({})).toHaveLength(0);
    expect(hookTargets({ hooks: {} })).toHaveLength(0);
  });
});

describe('reading the port', () => {
  it('takes the explicit one', () => {
    expect(portOf('http://127.0.0.1:4310/hooks/Stop')).toBe(4310);
  });

  it('falls back to the scheme default', () => {
    expect(portOf('http://board.local/hooks/Stop')).toBe(80);
    expect(portOf('https://board.local/hooks/Stop')).toBe(443);
  });

  it('says nothing rather than guessing at nonsense', () => {
    expect(portOf('not a url')).toBeNull();
  });
});

describe('comparing the two', () => {
  it('is satisfied when they agree', () => {
    const assessment = assessHookTarget({
      doc: settings('http://127.0.0.1:4300/hooks/PreToolUse'),
      port: 4300,
    });

    expect(assessment.verdict).toBe('agree');
  });

  it('names both numbers when they do not', () => {
    const assessment = assessHookTarget({
      doc: settings('http://127.0.0.1:4300/hooks/PreToolUse'),
      port: 4310,
    });

    // An operator staring at an empty board needs the two side by side to see
    // that there is a problem at all.
    expect(assessment.verdict).toBe('mismatch');
    expect(assessment.detail).toContain('4300');
    expect(assessment.detail).toContain('4310');
    expect(assessment.detail).toContain('dropped');
  });

  it('advises a flag that exists', () => {
    const assessment = assessHookTarget({
      doc: settings('http://127.0.0.1:4300/hooks/PreToolUse'),
      port: 4310,
    });

    // `init` takes --url, not --port. Advice that errors out on being followed
    // is worse than no advice, because the operator now doubts the diagnosis.
    expect(assessment.detail).toContain('gorilla init --url http://127.0.0.1:4310');
    expect(assessment.detail).not.toContain('init --port');
  });

  it('reports nothing configured separately from wrongly configured', () => {
    // These need different actions: one is `gorilla init`, the other is a
    // decision about which port is right.
    expect(assessHookTarget({ doc: {}, port: 4300 }).verdict).toBe('unconfigured');
  });
});

describe('the startup warning', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gorilla-target-'));
    mkdirSync(join(dir, '.claude'), { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const write = (file: string, doc: unknown): void =>
    writeFileSync(join(dir, '.claude', file), JSON.stringify(doc), 'utf8');

  it('warns when the board is somewhere the hooks are not', () => {
    write('settings.json', settings('http://127.0.0.1:4300/hooks/PreToolUse'));

    expect(hookTargetWarning(dir, 4310)).toContain('4300');
  });

  it('says nothing when they agree', () => {
    write('settings.json', settings('http://127.0.0.1:4300/hooks/PreToolUse'));

    expect(hookTargetWarning(dir, 4300)).toBeNull();
  });

  it('prefers the more specific settings file', () => {
    // settings.local.json is the one Claude Code applies over the shared file,
    // so a warning derived from the shared one could name a port nothing uses.
    write('settings.json', settings('http://127.0.0.1:4300/hooks/PreToolUse'));
    write('settings.local.json', settings('http://127.0.0.1:4310/hooks/PreToolUse'));

    expect(hookTargetWarning(dir, 4310)).toBeNull();
  });

  it('says nothing when there are no settings', () => {
    expect(hookTargetWarning(dir, 4300)).toBeNull();
  });

  it('does not invent a warning from a settings file it cannot parse', () => {
    writeFileSync(join(dir, '.claude', 'settings.json'), '{ not json', 'utf8');

    // `doctor` reports this properly. Guessing here would produce a scarier
    // message than the truth, about the wrong problem.
    expect(hookTargetWarning(dir, 4300)).toBeNull();
  });
});
