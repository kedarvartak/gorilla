import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDatabase, type DatabaseHandle } from '../src/server/db/client.js';
import {
  buildMechanicalLedger,
  changeEntries,
  commandEntries,
  riskEntries,
  unresolvedIntentEntries,
  verdictEntries,
} from '../src/server/ledger/mechanical.js';
import { checkReality, describeReality } from '../src/server/ledger/reality.js';
import { boards, events, runs } from '../src/server/db/schema.js';

let dir: string;
let handle: DatabaseHandle;
let seq = 0;

const RUN = 'run-1';

function emit(eventName: string, payload: Record<string, unknown>): void {
  seq += 1;
  handle.db
    .insert(events)
    .values({
      runId: RUN,
      sessionId: 's',
      seq,
      eventName,
      receivedAt: 1_000 + seq,
      payload: JSON.stringify(payload),
    })
    .run();
}

function edit(path: string): void {
  emit('PreToolUse', { tool_name: 'Edit', tool_input: { file_path: path } });
  emit('PostToolUse', { tool_name: 'Edit', tool_input: { file_path: path } });
}

function bash(command: string, completed = true): void {
  emit('PreToolUse', { tool_name: 'Bash', tool_input: { command } });
  if (completed) emit('PostToolUse', { tool_name: 'Bash', tool_input: { command } });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gorilla-ledger-'));
  handle = openDatabase({ path: join(dir, 'ledger.db') });
  seq = 0;

  handle.db.insert(boards).values({ id: 'b', name: 'n', cwd: dir, createdAt: 1 }).run();
  handle.db
    .insert(runs)
    .values({ id: RUN, boardId: 'b', sessionId: 's', cwd: dir, startedAt: 1 })
    .run();
});

afterEach(() => {
  handle.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('change entries', () => {
  it('aggregates repeated edits to one file into one entry', () => {
    edit('/p/src/a.ts');
    edit('/p/src/a.ts');
    edit('/p/src/b.ts');

    const entries = changeEntries({ sqlite: handle.sqlite, runId: RUN });

    expect(entries).toHaveLength(2);
    const a = entries.find((entry) => entry.filePaths?.[0] === '/p/src/a.ts');
    expect(a?.statement).toContain('2 edits');
    expect(a?.sourceEventIds).toHaveLength(2);
  });

  it('names its source events, so every claim is checkable', () => {
    edit('/p/src/a.ts');
    for (const entry of changeEntries({ sqlite: handle.sqlite, runId: RUN })) {
      expect(entry.sourceEventIds.length).toBeGreaterThan(0);
    }
  });

  it('ignores a payload with no file path rather than inventing one', () => {
    emit('PostToolUse', { tool_name: 'Edit', tool_input: {} });
    expect(changeEntries({ sqlite: handle.sqlite, runId: RUN })).toHaveLength(0);
  });
});

describe('material commands', () => {
  it.each([
    ['npm install express', 'added or changed a dependency'],
    ['pip install requests', 'added a Python dependency'],
    ['npx drizzle-kit generate', 'changed the database schema'],
    ['rm -rf build', 'deleted files'],
    ['git push origin main', 'performed a history operation'],
  ])('records %j', (command, expected) => {
    bash(command);
    const entries = commandEntries({ sqlite: handle.sqlite, runId: RUN });

    expect(entries).toHaveLength(1);
    expect(entries[0]?.statement).toContain(expected);
  });

  it('ignores ordinary commands', () => {
    bash('npm test');
    bash('ls -la');
    expect(commandEntries({ sqlite: handle.sqlite, runId: RUN })).toHaveLength(0);
  });

  it('does not report the same command twice from its two events', () => {
    bash('npm install express');
    expect(commandEntries({ sqlite: handle.sqlite, runId: RUN })).toHaveLength(1);
  });
});

describe('risk entries', () => {
  it('records a tool failure with its reason', () => {
    emit('PostToolUseFailure', { tool_name: 'Bash', tool_error: 'command not found' });

    const entries = riskEntries({ sqlite: handle.sqlite, runId: RUN });
    expect(entries[0]?.statement).toContain('Bash failed');
    expect(entries[0]?.detail).toContain('command not found');
  });

  it('records an API failure that ended the turn', () => {
    emit('StopFailure', { error_type: 'rate_limit' });

    expect(riskEntries({ sqlite: handle.sqlite, runId: RUN })[0]?.statement).toContain(
      'API failure',
    );
  });

  it('records an explicit denial', () => {
    emit('PermissionDenied', { tool_name: 'Bash', denial_reason: 'not allowed' });

    const entries = riskEntries({ sqlite: handle.sqlite, runId: RUN });
    expect(entries.some((entry) => entry.statement.includes('denied'))).toBe(true);
  });

  it('catches a refusal that emits no event of its own', () => {
    // The measured shape of a denial under dontAsk: intent, then nothing.
    bash('curl https://example.com', false);
    bash('curl https://example.org', false);

    const entries = unresolvedIntentEntries({ sqlite: handle.sqlite, runId: RUN });

    expect(entries).toHaveLength(1);
    expect(entries[0]?.statement).toContain('2 time(s) with no outcome');
    expect(entries[0]?.sourceEventIds).toHaveLength(2);
  });

  it('reports nothing unresolved when every call completed', () => {
    bash('npm test');
    edit('/p/a.ts');
    expect(unresolvedIntentEntries({ sqlite: handle.sqlite, runId: RUN })).toHaveLength(0);
  });
});

describe('verdict entries', () => {
  it('keeps the evaluator’s reason, which says what the agent thought was left', () => {
    const entries = verdictEntries([
      { verdict: 'not yet met', reason: 'two tests still failing', at: 1 },
    ]);

    expect(entries[0]?.statement).toContain('not yet met');
    expect(entries[0]?.detail).toBe('two tests still failing');
  });
});

describe('buildMechanicalLedger', () => {
  it('combines every source and lists the changed files', () => {
    edit('/p/src/a.ts');
    bash('npm install left-pad');
    emit('PostToolUseFailure', { tool_name: 'Bash', tool_error: 'boom' });

    const ledger = buildMechanicalLedger({ sqlite: handle.sqlite, runId: RUN });

    expect(ledger.changed).toEqual(['/p/src/a.ts']);
    expect(ledger.entries.some((entry) => entry.kind === 'change')).toBe(true);
    expect(ledger.risks).toBeGreaterThan(0);
  });

  it('emits nothing untraceable', () => {
    edit('/p/src/a.ts');
    bash('npm install x');

    for (const entry of buildMechanicalLedger({ sqlite: handle.sqlite, runId: RUN }).entries) {
      expect(entry.sourceEventIds.length).toBeGreaterThan(0);
    }
  });

  it('produces an empty ledger for a run that did nothing', () => {
    expect(buildMechanicalLedger({ sqlite: handle.sqlite, runId: RUN }).entries).toEqual([]);
  });
});

describe('claim versus reality', () => {
  function repo(): string {
    const path = join(dir, 'repo');
    mkdirSync(path, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: path });
    execFileSync('git', ['config', 'user.email', 't@example.com'], { cwd: path });
    execFileSync('git', ['config', 'user.name', 'T'], { cwd: path });
    writeFileSync(join(path, 'tracked.txt'), 'original\n');
    execFileSync('git', ['add', '.'], { cwd: path });
    execFileSync('git', ['commit', '-qm', 'initial'], { cwd: path });
    return path;
  }

  it('finds a file changed on disk that the event stream never mentioned', async () => {
    const path = repo();
    writeFileSync(join(path, 'tracked.txt'), 'modified\n');
    writeFileSync(join(path, 'surprise.txt'), 'nobody mentioned me\n');

    const check = await checkReality({
      cwd: path,
      headShaAtStart: null,
      claimedPaths: [join(path, 'tracked.txt')],
    });

    expect(check.available).toBe(true);
    // This is where unobserved drift lives.
    expect(check.changedButUnmentioned).toContain('surprise.txt');
    expect(check.changedButUnmentioned).not.toContain('tracked.txt');
  });

  it('finds a file the agent touched but did not actually change', async () => {
    const path = repo();

    const check = await checkReality({
      cwd: path,
      headShaAtStart: null,
      claimedPaths: [join(path, 'tracked.txt')],
    });

    expect(check.mentionedButUnchanged).toContain('tracked.txt');
  });

  it('reports agreement when there is nothing to flag', async () => {
    const path = repo();
    writeFileSync(join(path, 'tracked.txt'), 'modified\n');

    const check = await checkReality({
      cwd: path,
      headShaAtStart: null,
      claimedPaths: [join(path, 'tracked.txt')],
    });

    expect(describeReality(check).join(' ')).toContain('agree');
  });

  it('degrades with a reason outside a repository, rather than throwing', async () => {
    const check = await checkReality({
      cwd: join(dir, 'not-a-repo'),
      headShaAtStart: null,
      claimedPaths: [],
    });

    expect(check.available).toBe(false);
    expect(describeReality(check)[0]).toContain('unavailable');
  });

  it('survives a base commit that no longer exists', async () => {
    const path = repo();
    writeFileSync(join(path, 'tracked.txt'), 'modified\n');

    const check = await checkReality({
      cwd: path,
      headShaAtStart: '0000000000000000000000000000000000000000',
      claimedPaths: [],
    });

    // The working-tree half is still valid, so it reports what it has.
    expect(check.available).toBe(true);
    expect(check.changedFiles).toContain('tracked.txt');
  });
});
