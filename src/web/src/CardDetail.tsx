import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';

import { Timeline } from './Timeline.js';

import { api, type Card, type GuardrailDetail, type MergeReport } from './api.js';

/**
 * Card detail (doc 09, screen 2).
 *
 * Three panes: specification, the brief, and live state. The centre pane is the
 * answer to "what happened while I was away", so it leads with what is new and
 * offers the raw entries only on request - a wall of entries is the volume
 * problem this product exists to remove (doc 03).
 *
 * The specification rail must show each guardrail's enforcement kind. An
 * interface that presents an advisory rule as though it were enforced sends
 * the operator into an unattended run believing in a protection that does not
 * exist (R10), so the kind is rendered beside every rule rather than being
 * available on hover.
 */

/**
 * How tall the pane opens, remembered across cards and reloads.
 *
 * Stored as a fraction rather than pixels so it survives a window resize: an
 * operator who dragged the pane to two thirds of a large screen means two
 * thirds, not 800 pixels.
 */
const HEIGHT_KEY = 'gorilla.detailHeightFraction';
const MIN_FRACTION = 0.2;
/** Never quite full: the board header is how you tell what else is running. */
const MAX_FRACTION = 0.94;
const DEFAULT_FRACTION = 0.48;
const NUDGE = 0.06;

function clampFraction(value: number): number {
  return Math.min(MAX_FRACTION, Math.max(MIN_FRACTION, value));
}

function storedFraction(): number {
  try {
    const raw = window.localStorage.getItem(HEIGHT_KEY);
    const value = raw === null ? Number.NaN : Number(raw);
    return Number.isFinite(value) ? clampFraction(value) : DEFAULT_FRACTION;
  } catch {
    // Private browsing, or storage disabled. A forgotten height is not an error.
    return DEFAULT_FRACTION;
  }
}

/**
 * The per-card model controls.
 *
 * `agentModel` and `agentEffort` reach `claude --model` and `--effort` for the
 * run; `synthesisModel` is used only for windows that escalate, which today
 * means compaction. They are separate on purpose: the model that does the work
 * and the model that describes the work are different decisions with different
 * costs, and a card doing mechanical work with subtle reasoning behind it wants
 * a cheap agent and an expensive synthesiser.
 *
 * Null everywhere means the board default, which is what most cards should say.
 */
const AGENT_MODELS = ['haiku', 'sonnet', 'opus', 'fable'] as const;
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

interface LedgerEntry {
  readonly kind: string;
  readonly statement: string;
  readonly detail?: string;
  readonly sourceEventIds: readonly number[];
}

interface RunDetail {
  readonly runId: string;
  readonly sessionId: string;
  readonly startedAt: number;
  readonly endedAt: number | null;
  /**
   * Why it ended. `interrupted` means the board deduced the end rather than
   * being told - it must never be presented as if the session reported it.
   */
  readonly endReason: string | null;
  readonly goalOutcome: string | null;
  readonly mode: 'launched' | 'attached';
  readonly events: number;
  readonly ledger: {
    readonly entries: readonly LedgerEntry[];
    readonly changed: readonly string[];
  };
}

interface VerifyReport {
  readonly status: 'passed' | 'failed' | 'errored' | 'skipped';
  readonly command: string;
  readonly exitCode: number | null;
  readonly output: string;
  readonly durationMs: number;
}

interface BriefSection {
  readonly title: string;
  readonly lines: readonly string[];
  readonly empty: boolean;
}

interface Surprise {
  readonly id: string;
  readonly kind: 'superseded' | 'assumption' | 'unmentioned-change';
  readonly headline: string;
  readonly detail?: string;
  readonly why: string;
  readonly target: { type: 'entry'; entryId: string } | { type: 'path'; path: string };
}

interface Brief {
  readonly headline: string;
  readonly sections: readonly BriefSection[];
  readonly unseenCount: number;
  readonly nothingNew: boolean;
  readonly extraction: {
    readonly configured: boolean;
    readonly tokensSpent: number;
    readonly note: string | null;
  };
  /** What the operator would regret not reading, still unjudged. */
  readonly surprises: readonly Surprise[];
}

interface Workspace {
  readonly branch: string;
  readonly worktree: string;
  readonly git: { branch: string; dirty: number; ahead: number } | null;
}

interface Detail {
  readonly card: Card;
  readonly verify: VerifyReport | null;
  readonly verifyNote: string | null;
  readonly guardrailDetail: readonly GuardrailDetail[];
  readonly blockers: readonly { cardId: string; title: string; status: string }[];
  readonly runs: readonly RunDetail[];
  readonly realityNotes: readonly string[];
  /** The isolated branch this card's work sits on, or null if it never ran. */
  readonly workspace: Workspace | null;
  /** The branch a merge would land on, named before it is offered. */
  readonly mergeTarget: string | null;
  readonly verifyCommand: string | null;
}

/** "4m 12s", so a run's cost in time is readable without arithmetic. */
function duration(fromMs: number, toMs: number): string {
  const seconds = Math.max(0, Math.round((toMs - fromMs) / 1000));
  if (seconds < 60) return `${String(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${String(minutes)}m ${String(seconds % 60)}s`;
  return `${String(Math.floor(minutes / 60))}h ${String(minutes % 60)}m`;
}

/**
 * What a run's end means, in the operator's words.
 *
 * The `interrupted` case is the one that matters: the board never saw the
 * session end, it worked out afterwards that it must have. Saying "finished"
 * there would be the board inventing a fact.
 */
function endedNote(run: RunDetail): { text: string; tone: string } {
  if (run.endedAt === null) return { text: 'running now', tone: 'text-ok' };

  const took = duration(run.startedAt, run.endedAt);

  if (run.endReason === 'interrupted') {
    return {
      text: `cut off after ${took} - the board never saw it end, so this time is an estimate`,
      tone: 'text-warn',
    };
  }

  return { text: `ran ${took}, ended: ${run.endReason ?? 'no reason given'}`, tone: 'text-dim' };
}

const KIND_COLOUR: Record<string, string> = {
  change: 'text-info',
  risk: 'text-warn',
  question: 'text-accent',
  verdict: 'text-ok',
};

/** One labelled select over a nullable card field, saving on change. */
function FieldSelect({
  label,
  value,
  options,
  title,
  neutralLabel = 'board default',
  onPick,
}: {
  label: string;
  value: string | null;
  options: readonly string[];
  title: string;
  /** What "unset" means for this field; not every field defers to the board. */
  neutralLabel?: string;
  onPick: (value: string | null) => void;
}): ReactElement {
  return (
    <>
      <dt className="text-dim" title={title}>
        {label}
      </dt>
      <dd>
        <select
          className="w-full rounded border border-line bg-panel-2 px-1 py-0.5 text-text"
          value={value ?? ''}
          aria-label={label}
          onChange={(changed) => onPick(changed.target.value === '' ? null : changed.target.value)}
        >
          <option value="">{neutralLabel}</option>
          {options.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
          {/* A value set by /gorilla:plan or curl may not be in the list. Showing
              it is the difference between an honest control and one that lies
              about what the card will actually run. */}
          {value !== null && !options.includes(value) ? (
            <option value={value}>{value}</option>
          ) : null}
        </select>
      </dd>
    </>
  );
}

function Rail({ title, children }: { title: string; children: ReactElement | ReactElement[] }) {
  return (
    <section className="min-w-0 flex-1 overflow-y-auto border-line px-4 py-3">
      <h3 className="mb-2 font-mono text-[11px] uppercase tracking-wider text-dim">{title}</h3>
      {children}
    </section>
  );
}

export function CardDetail({
  cardId,
  onClose,
}: {
  cardId: string;
  onClose: () => void;
}): ReactElement {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [brief, setBrief] = useState<Brief | null>(null);
  const [showEntries, setShowEntries] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [timelineRunId, setTimelineRunId] = useState<string | null>(null);
  const [fraction, setFraction] = useState(storedFraction);
  const [dragging, setDragging] = useState(false);
  /** The height to come back to when the pane is un-maximised. */
  const restoreTo = useRef(storedFraction());

  useEffect(() => {
    try {
      window.localStorage.setItem(HEIGHT_KEY, String(fraction));
    } catch {
      /* storage unavailable; the height simply is not remembered */
    }
  }, [fraction]);

  /**
   * Drag on the top edge to resize.
   *
   * Pointer capture rather than window listeners: the pointer keeps reporting to
   * the handle even when it leaves it, so a fast drag past the edge of the pane
   * does not silently stop resizing.
   */
  const startDrag = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    setDragging(true);

    const move = (moved: PointerEvent): void => {
      setFraction(clampFraction((window.innerHeight - moved.clientY) / window.innerHeight));
    };

    const stop = (): void => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', stop);
      handle.removeEventListener('pointercancel', stop);
      try {
        handle.releasePointerCapture(event.pointerId);
      } catch {
        /* already released */
      }
      setDragging(false);
    };

    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', stop);
    handle.addEventListener('pointercancel', stop);
  }, []);

  /** Dragging is not usable from a keyboard, so the separator takes arrow keys. */
  const nudge = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    const step: Record<string, number> = { ArrowUp: NUDGE, ArrowDown: -NUDGE };
    const delta = step[event.key];

    if (delta !== undefined) {
      event.preventDefault();
      setFraction((current) => clampFraction(current + delta));
      return;
    }
    if (event.key === 'Home') {
      event.preventDefault();
      setFraction(MAX_FRACTION);
    }
    if (event.key === 'End') {
      event.preventDefault();
      setFraction(MIN_FRACTION);
    }
  }, []);

  const maximised = fraction >= MAX_FRACTION - 0.001;

  const toggleMaximised = useCallback(() => {
    setFraction((current) => {
      if (current >= MAX_FRACTION - 0.001) return clampFraction(restoreTo.current);
      restoreTo.current = current;
      return MAX_FRACTION;
    });
  }, []);

  const [merging, setMerging] = useState(false);
  const [mergeReport, setMergeReport] = useState<MergeReport | null>(null);
  /** Set only when the gate declined. Judgement is offered here and nowhere else. */
  const [mergeRefusal, setMergeRefusal] = useState<{ summary: string; reach: string } | null>(null);

  /**
   * Merges this card alone.
   *
   * The same reviewer the morning batch uses, given one card: it merges, runs
   * the card's verify, and stops with the conflict left in the tree if anything
   * breaks. The server moves a merged card to the terminal column, so "merged"
   * and "done" cannot drift apart.
   */
  const mergeThisCard = useCallback(() => {
    if (detail === null) return;
    setMerging(true);
    setMergeReport(null);
    setMergeRefusal(null);

    void api
      .mergeCards(detail.card.boardId, {
        cardIds: [detail.card.id],
        ...(detail.mergeTarget === null ? {} : { into: detail.mergeTarget }),
        verify: detail.verifyCommand,
      })
      .then((report) => {
        setMergeReport(report);
        return fetch(`/api/cards/${cardId}/detail`);
      })
      .then(async (response) => {
        if (response.ok) setDetail((await response.json()) as Detail);
      })
      .catch((cause: Error & { refusal?: { summary: string; reach: string } }) => {
        // A refusal is not an error to report at the top of the pane: it is the
        // gate working, and it comes with something to do about it.
        if (cause.refusal !== undefined) setMergeRefusal(cause.refusal);
        else setError(cause.message);
      })
      .finally(() => setMerging(false));
  }, [cardId, detail]);

  /**
   * Records a verdict, then re-reads the brief.
   *
   * Refetched rather than patched locally: rejecting an entry changes which
   * sections assert what, and recomputing that here would be a second
   * implementation of the rule that could drift from the server's.
   */
  const judge = useCallback(
    (target: Surprise['target'], status: 'accepted' | 'rejected') => {
      if (target.type !== 'entry') return;

      void api
        .judgeEntry(target.entryId, { status })
        .then(() => fetch(`/api/cards/${cardId}/brief`))
        .then(async (response) => {
          if (response.ok) setBrief((await response.json()) as Brief);
        })
        .catch((cause: Error) => setError(cause.message));
    },
    [cardId],
  );

  /** Save a model choice, then re-read the card so the rail shows what is stored. */
  const patch = useCallback(
    (body: Parameters<typeof api.updateCard>[1]) => {
      void api
        .updateCard(cardId, body)
        .then((card) => {
          setDetail((current) => (current === null ? current : { ...current, card }));
        })
        .catch((cause: Error) => setError(cause.message));
    },
    [cardId],
  );

  useEffect(() => {
    let cancelled = false;

    async function load(): Promise<void> {
      try {
        const [detailResponse, briefResponse] = await Promise.all([
          fetch(`/api/cards/${cardId}/detail`),
          fetch(`/api/cards/${cardId}/brief`),
        ]);

        if (!detailResponse.ok) throw new Error(`Could not load card: ${detailResponse.status}`);
        const body = (await detailResponse.json()) as Detail;
        if (!cancelled) setDetail(body);

        // A brief that will not load must not hide the rest of the card.
        if (briefResponse.ok && !cancelled) setBrief((await briefResponse.json()) as Brief);

        // Marked seen only after the brief has been computed. The other order
        // makes "since you last looked" permanently empty, because opening the
        // card would move the line the brief is measured against.
        await fetch(`/api/cards/${cardId}/seen`, { method: 'POST' });
      } catch (cause) {
        if (!cancelled) setError((cause as Error).message);
      }
    }

    void load();

    return () => {
      cancelled = true;
    };
  }, [cardId]);

  if (error !== null) {
    return (
      <div className="border-t border-line bg-panel px-4 py-3 text-warn">
        {error}{' '}
        <button type="button" className="underline" onClick={onClose}>
          close
        </button>
      </div>
    );
  }

  if (detail === null) {
    return <div className="border-t border-line bg-panel px-4 py-3 text-dim">Loading…</div>;
  }

  const entries = detail.runs.flatMap((run) => run.ledger.entries);
  const latest = detail.runs[detail.runs.length - 1];

  return (
    <div
      className="flex flex-col border-t border-line bg-panel"
      style={{ height: `${(fraction * 100).toFixed(2)}%` }}
    >
      {/* The resize handle. `separator` with an orientation and a value is what
          makes this reachable without a pointer. */}
      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize the card pane"
        aria-valuenow={Math.round(fraction * 100)}
        aria-valuemin={Math.round(MIN_FRACTION * 100)}
        aria-valuemax={Math.round(MAX_FRACTION * 100)}
        tabIndex={0}
        onPointerDown={startDrag}
        onKeyDown={nudge}
        title="Drag, or focus and use the arrow keys, to resize"
        className={`group -mt-1 h-2 shrink-0 cursor-ns-resize ${
          dragging ? 'bg-accent/60' : 'bg-transparent hover:bg-accent/30'
        } focus:bg-accent/50 focus:outline-none`}
      >
        <div className="mx-auto mt-0.5 h-0.5 w-10 rounded bg-line group-hover:bg-accent/60" />
      </div>

      <header className="flex items-baseline gap-3 border-b border-line px-4 py-2">
        <h2 className="text-text">{detail.card.title}</h2>
        <span className="font-mono text-[11px] text-dim">{detail.card.status}</span>
        <button
          type="button"
          className="ml-auto rounded border border-line px-2 py-0.5 font-mono text-[11px] text-dim hover:text-text"
          onClick={toggleMaximised}
          title={maximised ? 'Restore the previous height' : 'Stretch the pane over the board'}
        >
          {maximised ? 'restore' : 'expand'}
        </button>
        <button
          type="button"
          className="rounded border border-line px-2 py-0.5 text-dim hover:text-text"
          onClick={onClose}
        >
          close
        </button>
      </header>

      <div className="flex min-h-0 flex-1 divide-x divide-line">
        <Rail title="Specification">
          <>
            {detail.card.body === '' ? (
              <p className="mb-3 text-dim">No description.</p>
            ) : (
              <p className="mb-3 whitespace-pre-wrap text-text">{detail.card.body}</p>
            )}

            <dl className="mb-3 grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-1 font-mono text-[11px]">
              <FieldSelect
                label="priority"
                value={detail.card.priority === 'normal' ? null : detail.card.priority}
                options={['high', 'low']}
                title="Reorders the dispatch queue within this card's column."
                neutralLabel="normal"
                onPick={(priority) =>
                  patch({ priority: (priority ?? 'normal') as Card['priority'] })
                }
              />
              <FieldSelect
                label="agent"
                value={detail.card.agentModel}
                options={AGENT_MODELS}
                title="Reaches `claude --model` for this card's run."
                onPick={(agentModel) => patch({ agentModel })}
              />
              <FieldSelect
                label="effort"
                value={detail.card.agentEffort}
                options={EFFORTS}
                title="Reaches `claude --effort` for this card's run."
                onPick={(agentEffort) => patch({ agentEffort })}
              />
              <FieldSelect
                label="synthesis"
                value={detail.card.synthesisModel}
                options={AGENT_MODELS}
                title="Used only for windows that escalate - compaction, and manual re-extraction. Not the model that does the work."
                onPick={(synthesisModel) => patch({ synthesisModel })}
              />
              <dt className="text-dim">goal</dt>
              <dd className={detail.card.goalCondition === null ? 'text-warn' : ''}>
                {detail.card.goalCondition ?? 'not set - cannot be dispatched'}
              </dd>
            </dl>

            <h4 className="mb-1 font-mono text-[11px] uppercase tracking-wider text-dim">
              Guardrails
            </h4>
            {detail.guardrailDetail.length === 0 ? (
              <p className="text-dim">None.</p>
            ) : (
              <ul className="flex flex-col gap-1">
                {detail.guardrailDetail.map((rail) => (
                  <li key={`${rail.kind}:${rail.text}`} className="leading-snug">
                    <span
                      className={`mr-1.5 rounded-sm px-1 font-mono text-[10px] uppercase ${
                        rail.enforcement === 'hard' ? 'bg-ok/20 text-ok' : 'bg-dim/20 text-dim'
                      }`}
                      title={rail.because}
                    >
                      {rail.enforcement}
                    </span>
                    <span className="text-text">{rail.text}</span>
                  </li>
                ))}
              </ul>
            )}

            {detail.blockers.length > 0 ? (
              <p className="mt-3 text-warn">
                Blocked by: {detail.blockers.map((blocker) => blocker.title).join(', ')}
              </p>
            ) : (
              <></>
            )}
          </>
        </Rail>

        <Rail
          title={
            brief === null
              ? 'Brief'
              : `Brief · ${brief.nothingNew ? 'nothing new' : `${brief.unseenCount} new`}`
          }
        >
          <>
            {/* Verify output only when it did not pass. When it passed, the
                brief's one line is enough and a green box is just noise. */}
            {detail.verify === null || detail.verify.status === 'passed' ? null : (
              <div className="mb-3 rounded border border-warn/40 bg-warn/10 px-2 py-1.5 text-warn">
                {/* The board ran this. It does not depend on the agent
                    reporting honestly, which is the whole point (R10). */}
                <div className="font-mono text-[11px]">{detail.verifyNote}</div>
                <pre className="mt-1 max-h-32 overflow-y-auto whitespace-pre-wrap font-mono text-[10px] text-dim">
                  {detail.verify.output}
                </pre>
              </div>
            )}

            {brief === null ? (
              <p className="text-dim">The brief could not be loaded.</p>
            ) : (
              <>
                {brief.extraction.note === null ? null : (
                  <p className="mb-3 rounded border border-warn/40 bg-warn/10 px-2 py-1.5 text-[11px] text-warn">
                    {brief.extraction.note}
                  </p>
                )}

                {mergeRefusal === null ? null : (
                  <div className="mb-3 rounded border border-warn/50 bg-warn/10 px-2 py-1.5">
                    <h4 className="mb-1 font-mono text-[11px] uppercase tracking-wider text-warn">
                      The merge was refused
                    </h4>
                    <p className="mb-1 leading-snug text-text">{mergeRefusal.summary}</p>
                    <p className="mb-2 font-mono text-[10px] text-dim">{mergeRefusal.reach}</p>

                    {/* Judgement appears here and nowhere else. Asking on every
                        card view is a standing request the operator learns to
                        scroll past; asking at the moment it blocks something is
                        a question with a reason attached. */}
                    <ul className="flex flex-col gap-2">
                      {brief.surprises.map((surprise) => (
                        <li key={surprise.id} className="leading-snug">
                          <div className="text-text">{surprise.headline}</div>
                          <div className="font-mono text-[10px] text-dim">{surprise.why}</div>
                          {surprise.target.type === 'path' ? (
                            <div className="font-mono text-[10px] text-dim">
                              Not an entry, so there is nothing to accept: open the file.
                            </div>
                          ) : (
                            <div className="mt-0.5 flex gap-2">
                              <button
                                type="button"
                                className="rounded border border-ok/50 px-1.5 font-mono text-[10px] text-ok hover:bg-ok/10"
                                onClick={() => judge(surprise.target, 'accepted')}
                              >
                                accept
                              </button>
                              <button
                                type="button"
                                className="rounded border border-warn/50 px-1.5 font-mono text-[10px] text-warn hover:bg-warn/10"
                                title="Kept on the card, but no longer stated as fact in the brief."
                                onClick={() => judge(surprise.target, 'rejected')}
                              >
                                reject
                              </button>
                            </div>
                          )}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {brief.sections.map((section) => (
                  <div key={section.title} className="mb-3">
                    <h4 className="mb-1 font-mono text-[11px] uppercase tracking-wider text-dim">
                      {section.title}
                    </h4>
                    {section.lines.map((line, index) => (
                      <p
                        key={`${section.title}-${String(index)}`}
                        className={`whitespace-pre-wrap leading-snug ${
                          section.empty
                            ? 'text-dim'
                            : line.startsWith('REVERSED:')
                              ? 'text-warn'
                              : line.startsWith('Needs you:')
                                ? 'text-accent'
                                : 'text-text'
                        }`}
                      >
                        {line}
                      </p>
                    ))}
                  </div>
                ))}
              </>
            )}

            {entries.length === 0 ? (
              <></>
            ) : (
              <div className="border-t border-line pt-2">
                <button
                  type="button"
                  className="font-mono text-[11px] text-info hover:underline"
                  onClick={() => setShowEntries(!showEntries)}
                >
                  {showEntries ? 'hide' : 'show'} the {entries.length} underlying entr
                  {entries.length === 1 ? 'y' : 'ies'}
                </button>

                {!showEntries ? null : (
                  <ul className="mt-2 flex flex-col gap-2">
                    {entries.map((entry, index) => (
                      <li key={`${entry.kind}-${index}`} className="border-l-2 border-line pl-2">
                        <span
                          className={`mr-1.5 font-mono text-[10px] uppercase ${
                            KIND_COLOUR[entry.kind] ?? 'text-dim'
                          }`}
                        >
                          {entry.kind}
                        </span>
                        <span className="text-text">{entry.statement}</span>
                        {entry.detail === undefined ? null : (
                          <div className="mt-0.5 font-mono text-[11px] text-dim">
                            {entry.detail}
                          </div>
                        )}
                        <div className="font-mono text-[10px] text-dim">
                          {/* Every entry names its evidence; nothing here is
                              unfalsifiable (doc 08). */}
                          {entry.sourceEventIds.length} source event(s)
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            {detail.realityNotes.length > 0 ? (
              <div className="mt-4 border-t border-line pt-2">
                <h4 className="mb-1 font-mono text-[11px] uppercase tracking-wider text-dim">
                  Claim versus reality
                </h4>
                {detail.realityNotes.map((note) => (
                  <p key={note} className="text-dim">
                    {note}
                  </p>
                ))}
              </div>
            ) : (
              <></>
            )}
          </>
        </Rail>

        <Rail title={detail.runs.length === 0 ? 'Runs' : `Runs (${detail.runs.length})`}>
          <>
            {detail.runs.length === 0 ? (
              <p className="text-dim">
                Never run. Nothing has been dispatched against this card, so there is nothing to
                review.
              </p>
            ) : (
              <ul className="mb-3 flex flex-col gap-2 font-mono text-[11px]">
                {detail.runs.map((run) => {
                  const ended = endedNote(run);
                  return (
                    <li key={run.runId} className="border-l-2 border-line pl-2">
                      <div className="text-text">
                        {run.sessionId.slice(0, 8)}
                        <span className="ml-1.5 text-dim">
                          {run.mode}
                          {run.runId === latest?.runId ? ' · latest' : ''}
                        </span>
                      </div>
                      <div className="text-dim">
                        {new Date(run.startedAt).toLocaleString()} · {run.events} events
                      </div>
                      <div className={ended.tone}>{ended.text}</div>
                      {run.goalOutcome === null ? null : (
                        <div className="text-dim">goal: {run.goalOutcome}</div>
                      )}
                      <button
                        type="button"
                        className="text-info hover:underline"
                        onClick={() => setTimelineRunId(run.runId)}
                      >
                        timeline
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}

            {/* The close-out. Everything the operator needs in order to decide
                is above; this is the decision, named rather than implied. */}
            <div className="border-t border-line pt-2">
              <h4 className="mb-1 font-mono text-[11px] uppercase tracking-wider text-dim">
                Review and close
              </h4>

              {detail.card.mergedAt !== null ? (
                <p className="mb-2 font-mono text-[11px] text-ok">
                  Merged into {detail.card.mergedInto ?? 'the target branch'} from{' '}
                  {detail.card.mergedBranch ?? 'its branch'} on{' '}
                  {new Date(detail.card.mergedAt).toLocaleString()}.
                </p>
              ) : detail.workspace === null ? (
                <p className="font-mono text-[11px] text-dim">
                  No worktree, and the board has not merged this card. If it is finished, the work
                  reached the target some other way.
                </p>
              ) : (
                <div className="mb-2 font-mono text-[11px]">
                  <div className="text-text">{detail.workspace.branch}</div>
                  <div className="text-dim">{detail.workspace.worktree}</div>
                  {detail.workspace.git === null ? null : (
                    <div className={detail.workspace.git.dirty > 0 ? 'text-warn' : 'text-dim'}>
                      {detail.workspace.git.ahead} commit(s) ahead
                      {detail.workspace.git.dirty > 0
                        ? `, ${detail.workspace.git.dirty} uncommitted change(s) - these would not be merged`
                        : ', working tree clean'}
                    </div>
                  )}
                </div>
              )}

              <div className="flex flex-wrap gap-2">
                {detail.workspace === null || detail.card.mergedAt !== null ? null : (
                  <button
                    type="button"
                    className="rounded border border-ok/50 px-2 py-0.5 font-mono text-[11px] text-ok hover:bg-ok/10 disabled:opacity-40"
                    disabled={merging}
                    title={
                      detail.verifyCommand === null
                        ? 'Merges without running anything afterwards: this card has no verify command.'
                        : `Merges, then runs ${detail.verifyCommand}. Stops and leaves the conflict in place if it does not pass.`
                    }
                    onClick={mergeThisCard}
                  >
                    {merging
                      ? 'merging…'
                      : `merge into ${detail.mergeTarget ?? 'the current branch'}`}
                  </button>
                )}

                <button
                  type="button"
                  className="rounded border border-line px-2 py-0.5 font-mono text-[11px] text-dim hover:text-text"
                  title="Marks the card finished without merging anything. Use when the work landed another way, or was not needed."
                  onClick={() => patch({ status: 'done' })}
                >
                  mark done
                </button>

                {detail.card.status === 'idle' ? null : (
                  <button
                    type="button"
                    className="rounded border border-line px-2 py-0.5 font-mono text-[11px] text-dim hover:text-text"
                    title="Back to idle, which is the only status the queue will dispatch."
                    onClick={() => patch({ status: 'idle' })}
                  >
                    reopen
                  </button>
                )}
              </div>

              {mergeReport === null ? null : (
                <pre
                  className={`mt-2 max-h-40 overflow-y-auto whitespace-pre-wrap font-mono text-[10px] ${
                    mergeReport.clean ? 'text-ok' : 'text-warn'
                  }`}
                >
                  {mergeReport.summary.join('\n')}
                </pre>
              )}
            </div>
          </>
        </Rail>
      </div>

      {timelineRunId === null ? null : (
        <Timeline runId={timelineRunId} onClose={() => setTimelineRunId(null)} />
      )}
    </div>
  );
}
