import { useState, type ReactElement, type ReactNode } from 'react';
import type { api, Card, GuardrailDetail } from './api.js';
import type { GuardrailSet } from './CardDetail.js';
import { Select, type SelectOption } from './Select.js';

type Update = Parameters<typeof api.updateCard>[1];

/**
 * The specification pane.
 *
 * Laid out to the height of the pane rather than to the length of its content.
 * Stacked as a document - two fields, two disclosures, an aside, a footer -
 * this surface ran about twice the height of the flap, so the operator set a
 * goal at the top, scrolled past two closed accordions, and dispatched from a
 * footer that had no relation on screen to what it was dispatching. Every
 * field is now on screen at once: the form fills its box, the fields share the
 * height, and each one scrolls inside itself when what it holds is long.
 *
 * The disclosures are gone with it. They bought vertical space at the price of
 * hiding the two things - the brief and the boundaries - that decide what an
 * unattended agent does overnight.
 */

/** One bordered cell. The label is structure, so it is set as an eyebrow. */
function Field({
  label,
  hint,
  children,
  className = '',
}: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
  className?: string;
}): ReactElement {
  return (
    <section
      className={`flex min-h-0 min-w-0 flex-col rounded-lg border border-line bg-surface transition-colors focus-within:border-edge ${className}`}
    >
      <div className="flex items-baseline justify-between gap-2 px-3 pb-1 pt-2">
        <span className="eyebrow">{label}</span>
        {hint === undefined ? null : <span className="t-fine text-faint">{hint}</span>}
      </div>
      {children}
    </section>
  );
}

/** A single draft makes Save & run use exactly the settings on screen. */
export function CardSetup({
  card,
  rails,
  enforcement,
  onSave,
  onRun,
  runDisabled,
}: {
  card: Card;
  rails: GuardrailSet;
  enforcement: readonly GuardrailDetail[];
  onSave: (update: Update) => Promise<void>;
  onRun: () => Promise<void>;
  runDisabled: string | null;
}): ReactElement {
  const [body, setBody] = useState(card.body);
  const [goal, setGoal] = useState(card.goalCondition ?? '');
  const [verify, setVerify] = useState(rails.verify ?? '');
  const [scope, setScope] = useState(rails.scope.join('\n'));
  const [rules, setRules] = useState(rails.prohibit.join('\n'));
  const [provider, setProvider] = useState(card.agentProvider ?? 'claude');
  const [model, setModel] = useState(card.agentModel ?? '');
  const [effort, setEffort] = useState(card.agentEffort ?? '');
  const [baseBranch, setBaseBranch] = useState(card.baseBranch ?? '');
  const [sourceBranch, setSourceBranch] = useState(card.sourceBranch ?? '');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const lines = (value: string): string[] =>
    value
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);

  /* No border and no ground of its own: the cell around it carries both, and a
     field drawn inside a field is two boxes for one value. `min-h-0` with a
     floor lets the row share out the height and the text scroll inside it. */
  const area =
    'min-h-0 flex-1 resize-none bg-transparent px-3 pb-2.5 text-ink placeholder:text-faint focus:outline-none';

  const providers: readonly SelectOption[] = [
    { value: 'claude', label: 'Claude Code', hint: 'Claude Code session, observed through hooks.' },
    { value: 'codex', label: 'Codex', hint: 'Codex session, observed from its event stream.' },
  ];
  const models: readonly SelectOption[] =
    provider === 'codex'
      ? [
          { value: '', label: 'Provider default' },
          ...[
            'gpt-5.4-mini',
            'gpt-5.4',
            'gpt-5.5',
            'gpt-5.6-luna',
            'gpt-5.6-sol',
            'gpt-5.6-terra',
          ].map((value) => ({ value, label: value })),
        ]
      : [
          { value: '', label: 'Provider default' },
          ...['haiku', 'sonnet', 'opus', 'fable'].map((value) => ({ value, label: value })),
        ];
  const efforts: readonly SelectOption[] = [
    { value: '', label: 'Provider default' },
    ...['low', 'medium', 'high', 'xhigh', 'max'].map((value) => ({ value, label: value })),
  ];

  /**
   * What this card still needs, in the order it is filled in.
   *
   * Four facts the operator otherwise has to reconstruct by reading four
   * fields. Only the goal is marked - it is the one thing that stops a
   * dispatch, and the board's rule is that colour is spent on what wants a
   * person. A card with no verify command is a judgement, not a fault.
   */
  const bounds = lines(scope).length + lines(rules).length;
  const steps: readonly { label: string; set: boolean; blocking?: boolean }[] = [
    { label: 'Task', set: body.trim() !== '', blocking: true },
    { label: 'Outcome', set: goal.trim() !== '', blocking: true },
  ];

  /*
   * What this card will actually run with.
   *
   * Stamped from the project's execution policy when the card was created, so
   * these are the card's own values rather than a live reading of the policy -
   * which is why this says what the card does rather than what the project
   * does. Stated in one quiet line because the answer is almost always "the
   * usual", and a settings panel for a decision nobody is making is four
   * controls charging rent.
   */
  const runsWith = [
    provider === 'codex' ? 'Codex' : 'Claude Code',
    model === '' ? null : model,
    effort === '' ? null : effort,
    verify.trim() === '' ? 'no check set' : `checks with ${verify.trim().split('\n')[0] ?? ''}`,
  ].filter((part): part is string => part !== null);

  async function save(run: boolean): Promise<void> {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      await onSave({
        body,
        goalCondition: goal.trim() || null,
        agentProvider: provider,
        agentModel: model.trim() || null,
        agentEffort: effort || null,
        baseBranch: baseBranch.trim() || null,
        sourceBranch: sourceBranch.trim() || null,
        guardrails: {
          ...rails,
          scope: lines(scope),
          prohibit: lines(rules),
          verify: verify.trim() || null,
        },
      });
      setNote('Saved');
      if (run) await onRun();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      id="card-setup"
      /* Full height from `lg` up, where the grid has the width to trade for
         it. Narrower than that the cells are one column and the pane scrolls,
         which is the right shape for a phone. */
      className="flex min-h-0 flex-col gap-3 lg:h-full"
      onSubmit={(event) => {
        event.preventDefault();
        void save(false);
      }}
    >
      <header className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-line pb-2">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
          <h4 className="font-semibold text-ink">Ready this task</h4>
          <p className="t-small text-dim">
            Describe the task and what done looks like. The project decides the rest.
          </p>
        </div>
        <ul className="flex items-center gap-3" aria-label="What this task still needs">
          {steps.map((step) => (
            <li key={step.label} className="flex items-center gap-1.5 t-fine">
              <span
                aria-hidden
                className={`h-2 w-2 rounded-[2px] border ${
                  step.set
                    ? 'border-dim bg-dim'
                    : step.blocking === true
                      ? 'border-attention bg-attention-tint'
                      : 'border-edge'
                }`}
              />
              <span
                className={
                  step.set ? 'text-dim' : step.blocking === true ? 'text-attention' : 'text-faint'
                }
              >
                {step.label}
              </span>
              <span className="sr-only">{step.set ? 'set' : 'not set'}</span>
            </li>
          ))}
        </ul>
      </header>

      <fieldset
        disabled={busy || card.status === 'running'}
        className="flex min-h-0 flex-col gap-3 lg:flex-1"
      >
        {/* The two things a card is required to carry. Everything else the
            project already decided, which is the whole point of the policy:
            readying a task should be describing work, not configuring a
            runtime. */}
        <div className="grid min-h-0 gap-3 lg:flex-1 lg:grid-cols-2">
          <Field
            label="The task"
            hint={body.trim() === '' ? 'Required' : undefined}
            className="lg:min-h-[10rem]"
          >
            <textarea
              aria-label="Task instructions"
              className={area}
              rows={5}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="What should the agent build or change, and why? Include anything it could not work out from the code."
            />
          </Field>

          <Field
            label="The outcome"
            hint={goal.trim() === '' ? 'Required' : undefined}
            className="lg:min-h-[10rem]"
          >
            <textarea
              aria-label="goal condition"
              className={area}
              rows={5}
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              placeholder="What must be observably true when this is done? Name the evidence, not the intention."
            />
          </Field>
        </div>

        {/* One line, because the answer is almost always "the usual". It says
            what this card runs with rather than what the project runs with:
            the values were copied onto the card when it was created and a
            later change to the policy does not reach it. */}
        <p className="flex flex-wrap items-baseline gap-x-2 t-small text-dim">
          <span className="eyebrow">Runs</span>
          <span className="text-ink">{runsWith.join(' · ')}</span>
          <span className="text-faint">
            from the project&apos;s execution policy, copied here when this card was created
          </span>
        </p>

        <details className="rounded-lg border border-line bg-well px-3 py-2">
          <summary className="cursor-pointer t-small text-ink">
            Advanced
            <span className="ml-2 t-fine text-faint">
              Override the agent, the check, or where it may work
              {bounds === 0 ? '' : ` · ${String(bounds)} boundaries set`}
            </span>
          </summary>

          <div className="mt-3 grid gap-3 lg:grid-cols-[264px_minmax(0,1fr)_minmax(0,1fr)]">
            <div className="space-y-2.5">
              <label className="block">
                <span className="eyebrow">Agent</span>
                <Select
                  className="mt-1 w-full"
                  label="Provider"
                  value={provider}
                  options={providers}
                  onChange={(value) => {
                    setProvider(value as Card['agentProvider']);
                    setModel('');
                    setEffort('');
                  }}
                />
              </label>
              <label className="block">
                <span className="eyebrow">Model</span>
                <Select
                  className="mt-1 w-full"
                  label="Model"
                  value={model}
                  options={models}
                  onChange={setModel}
                />
              </label>
              <label className="block">
                <span className="eyebrow">Effort</span>
                <Select
                  className="mt-1 w-full"
                  label="Effort"
                  value={effort}
                  options={efforts}
                  onChange={setEffort}
                />
              </label>
            </div>

            <Field label="Verification" hint="Run by the board, not the agent">
              <textarea
                aria-label="verify command"
                className={`${area} font-mono t-small`}
                rows={3}
                value={verify}
                onChange={(e) => setVerify(e.target.value)}
                placeholder={'npm test'}
              />
            </Field>

            <Field
              label="Boundaries"
              hint={bounds === 0 ? 'Guidance, not a fence' : `${String(bounds)} set`}
            >
              <div className="grid grid-rows-2 divide-y divide-line">
                <label className="flex flex-col">
                  <span className="px-3 t-fine text-dim">Start looking in</span>
                  <textarea
                    aria-label="scope paths"
                    className={`${area} pt-0.5 font-mono t-small`}
                    rows={2}
                    value={scope}
                    onChange={(e) => setScope(e.target.value)}
                    placeholder={'src/auth/\ntest/auth/'}
                  />
                </label>
                <label className="flex flex-col pt-1.5">
                  <span className="px-3 t-fine text-dim">Restrictions</span>
                  <textarea
                    aria-label="prohibitions"
                    className={`${area} pt-0.5 t-small`}
                    rows={2}
                    value={rules}
                    onChange={(e) => setRules(e.target.value)}
                    placeholder={'Do not add dependencies\nsrc/db/schema.ts'}
                  />
                </label>
              </div>
            </Field>
          </div>

          <div className="mt-3 grid gap-3 border-t border-line pt-3 sm:grid-cols-2">
            <label className="block">
              <span className="eyebrow">Base branch</span>
              <input
                aria-label="base branch"
                className="mt-1 w-full rounded-md border border-line bg-surface px-2.5 py-1.5 font-mono t-small text-ink placeholder:text-faint focus:border-edge focus:outline-none"
                value={baseBranch}
                onChange={(event) => setBaseBranch(event.target.value)}
                placeholder="Current project branch"
              />
              <span className="mt-1 block t-fine text-faint">The agent starts here; its PR targets it.</span>
            </label>
            <label className="block">
              <span className="eyebrow">Source branch</span>
              <input
                aria-label="source branch"
                className="mt-1 w-full rounded-md border border-line bg-surface px-2.5 py-1.5 font-mono t-small text-ink placeholder:text-faint focus:border-edge focus:outline-none"
                value={sourceBranch}
                onChange={(event) => setSourceBranch(event.target.value)}
                placeholder="Generated for this card"
              />
              <span className="mt-1 block t-fine text-faint">The branch the agent publishes for review.</span>
            </label>
          </div>

          {enforcement.length === 0 ? null : (
            <div className="mt-3 border-t border-line pt-2.5">
              <span className="eyebrow">In force</span>
              <ul className="mt-1.5 max-h-24 space-y-1 overflow-y-auto t-fine text-dim">
                {enforcement.map((rail) => (
                  <li key={`${rail.kind}:${rail.text}`} className="leading-snug">
                    <span className="mr-1.5 font-medium text-ink">
                      {rail.enforcement === 'hard' ? 'Enforced' : 'Instruction'}
                    </span>
                    {rail.text}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </details>
      </fieldset>

      {/* The dispatch bar. One line, always in view, and the sentence beside
          the buttons says why the right-hand one is unavailable. */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-line pt-3">
        <button
          type="submit"
          disabled={busy || card.status === 'running'}
          className="rounded-md border border-line px-3 py-1.5 t-small text-ink transition-colors hover:border-edge disabled:opacity-50"
        >
          {busy ? 'Saving…' : 'Save settings'}
        </button>
        <button
          type="button"
          disabled={busy || !goal.trim() || runDisabled !== null}
          onClick={() => void save(true)}
          className="rounded-md bg-brand px-3 py-1.5 t-small font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          Save &amp; run agent
        </button>
        {error === null ? (
          <span role="status" className="min-w-0 t-small text-dim">
            {note ??
              runDisabled ??
              (body.trim() === ''
                ? 'Describe the task to run it.'
                : !goal.trim()
                  ? 'Add an outcome to run this task.'
                  : 'Ready when you are.')}
          </span>
        ) : (
          <p role="alert" className="min-w-0 t-small text-danger">
            {error}
          </p>
        )}
      </div>
    </form>
  );
}
