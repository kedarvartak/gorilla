import { useEffect, useState, type ReactElement } from 'react';

import { Timeline } from './Timeline.js';

import type { Card, GuardrailDetail } from './api.js';

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
}

interface Detail {
  readonly card: Card;
  readonly verify: VerifyReport | null;
  readonly verifyNote: string | null;
  readonly guardrailDetail: readonly GuardrailDetail[];
  readonly blockers: readonly { cardId: string; title: string; status: string }[];
  readonly runs: readonly RunDetail[];
  readonly realityNotes: readonly string[];
}

const KIND_COLOUR: Record<string, string> = {
  change: 'text-info',
  risk: 'text-warn',
  question: 'text-accent',
  verdict: 'text-ok',
};

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
    <div className="flex h-[48%] flex-col border-t border-line bg-panel">
      <header className="flex items-baseline gap-3 border-b border-line px-4 py-2">
        <h2 className="text-text">{detail.card.title}</h2>
        <span className="font-mono text-[11px] text-dim">{detail.card.status}</span>
        <button
          type="button"
          className="ml-auto rounded border border-line px-2 py-0.5 text-dim hover:text-text"
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

            <dl className="mb-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 font-mono text-[11px]">
              <dt className="text-dim">agent</dt>
              <dd>{detail.card.agentModel ?? 'board default'}</dd>
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

        <Rail title="Runs">
          {detail.runs.length === 0 ? (
            <p className="text-dim">Never run.</p>
          ) : (
            <ul className="flex flex-col gap-2 font-mono text-[11px]">
              {detail.runs.map((run) => (
                <li key={run.runId} className="flex flex-col">
                  <span className="text-text">{run.sessionId.slice(0, 8)}</span>
                  <span className="text-dim">
                    {new Date(run.startedAt).toLocaleString()} · {run.events} events
                  </span>
                  <span className="text-dim">
                    {run.endedAt === null ? 'in progress' : 'finished'}
                    {run.runId === latest?.runId ? ' · latest' : ''}
                  </span>
                  <button
                    type="button"
                    className="self-start text-info hover:underline"
                    onClick={() => setTimelineRunId(run.runId)}
                  >
                    timeline
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Rail>
      </div>

      {timelineRunId === null ? null : (
        <Timeline runId={timelineRunId} onClose={() => setTimelineRunId(null)} />
      )}
    </div>
  );
}
