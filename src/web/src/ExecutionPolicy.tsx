import { useEffect, useState, type ReactElement } from 'react';

import { api } from './api.js';
import { Select, type SelectOption } from './Select.js';

/**
 * The project's execution policy.
 *
 * Every card used to carry its own copy of these: which agent, which model, at
 * what effort, what to run to check it. That made readying a task an exercise
 * in configuration before it was an exercise in describing work, and it made
 * the settings drift - twenty cards holding twenty copies of a decision that
 * was made once.
 *
 * Stated here instead, and stamped onto a card when it is created. The stamp
 * is why this screen says what it applies to: a policy that silently reached
 * backwards would change what a card in the queue is about to run, which the
 * operator would discover afterwards, in a run they did not configure.
 */

export interface Policy {
  readonly provider: 'claude' | 'codex';
  readonly model: string | null;
  readonly effort: string | null;
  readonly permissionMode: string | null;
  readonly verify: string | null;
  readonly setup: string | null;
  readonly tokenCeiling: number | null;
}

const CLAUDE_MODELS = ['haiku', 'sonnet', 'opus', 'fable'];
const CODEX_MODELS = ['gpt-5.4-mini', 'gpt-5.4', 'gpt-5.5', 'gpt-5.6-sol', 'gpt-5.6-terra'];

const PROVIDERS: readonly SelectOption[] = [
  { value: 'claude', label: 'Claude Code', hint: 'Claude Code session, observed through hooks.' },
  { value: 'codex', label: 'Codex', hint: 'Codex session, observed from its event stream.' },
];

const EFFORTS: readonly SelectOption[] = [
  { value: '', label: 'Provider default' },
  ...['low', 'medium', 'high', 'xhigh', 'max'].map((value) => ({ value, label: value })),
];

function modelOptions(provider: string): readonly SelectOption[] {
  return [
    { value: '', label: 'Provider default' },
    ...(provider === 'codex' ? CODEX_MODELS : CLAUDE_MODELS).map((value) => ({
      value,
      label: value,
    })),
  ];
}

export function ExecutionPolicy({ boardId }: { boardId: string }): ReactElement {
  const [policy, setPolicy] = useState<Policy | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void api
      .policy<Policy>(boardId)
      .then((loaded) => {
        if (live) setPolicy(loaded);
      })
      .catch(() => {
        if (live) setError('Could not load the execution policy.');
      });
    return () => {
      live = false;
    };
  }, [boardId]);

  async function save(next: Policy): Promise<void> {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const saved = await api.savePolicy<Policy>(boardId, {
        provider: next.provider,
        model: next.model,
        effort: next.effort,
        verify: next.verify,
        setup: next.setup,
        tokenCeiling: next.tokenCeiling,
      });
      setPolicy(saved);
      setNote('Saved. New cards take these settings.');
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (policy === null) {
    return <p className="t-small text-dim">{error ?? 'Loading the execution policy…'}</p>;
  }

  const field =
    'w-full rounded-md border border-line bg-well px-2.5 py-1.5 t-small text-ink placeholder:text-faint focus:border-brand focus:outline-none';

  return (
    <section aria-label="Execution policy">
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="block">
          <span className="eyebrow">Agent</span>
          <Select
            className="mt-1 w-full"
            label="Project agent"
            value={policy.provider}
            options={PROVIDERS}
            onChange={(value) =>
              setPolicy({ ...policy, provider: value as Policy['provider'], model: null })
            }
          />
        </label>
        <label className="block">
          <span className="eyebrow">Model</span>
          <Select
            className="mt-1 w-full"
            label="Project model"
            value={policy.model ?? ''}
            options={modelOptions(policy.provider)}
            onChange={(value) => setPolicy({ ...policy, model: value === '' ? null : value })}
          />
        </label>
        <label className="block">
          <span className="eyebrow">Effort</span>
          <Select
            className="mt-1 w-full"
            label="Project effort"
            value={policy.effort ?? ''}
            options={EFFORTS}
            onChange={(value) => setPolicy({ ...policy, effort: value === '' ? null : value })}
          />
        </label>
      </div>

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="eyebrow">Prepare a worktree with</span>
          <input
            className={`${field} mt-1 font-mono`}
            aria-label="setup command"
            placeholder="npm ci"
            value={policy.setup ?? ''}
            onChange={(e) => setPolicy({ ...policy, setup: e.target.value || null })}
          />
          <span className="mt-1 block t-fine text-faint">
            Run by the board in each new worktree before the agent starts. A failure stops the
            dispatch and says why.
          </span>
        </label>
        <label className="block">
          <span className="eyebrow">Check the work with</span>
          <input
            className={`${field} mt-1 font-mono`}
            aria-label="verify command"
            placeholder="npm test"
            value={policy.verify ?? ''}
            onChange={(e) => setPolicy({ ...policy, verify: e.target.value || null })}
          />
          <span className="mt-1 block t-fine text-faint">
            Run by the board, not by the agent. Cards that name no check of their own take this one.
          </span>
        </label>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2">
          <span className="eyebrow">Token ceiling</span>
          <input
            className={`${field} w-40`}
            aria-label="token ceiling"
            placeholder="No ceiling"
            inputMode="numeric"
            value={policy.tokenCeiling === null ? '' : String(policy.tokenCeiling)}
            onChange={(e) =>
              setPolicy({
                ...policy,
                tokenCeiling: e.target.value.trim() === '' ? null : Number(e.target.value),
              })
            }
          />
        </label>
        <button
          type="button"
          disabled={busy}
          className="rounded-md bg-brand px-3 py-1.5 t-small font-medium text-white disabled:opacity-50"
          onClick={() => void save(policy)}
        >
          {busy ? 'Saving…' : 'Save policy'}
        </button>
        {error === null ? (
          <span role="status" className="t-small text-dim">
            {note ?? 'Applies to cards created from now on.'}
          </span>
        ) : (
          <span role="alert" className="t-small text-danger">
            {error}
          </span>
        )}
      </div>
    </section>
  );
}
