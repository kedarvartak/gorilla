import { useEffect, useState, type ReactElement } from 'react';

import type { Card, GuardrailDetail } from './api.js';

/**
 * Card detail (doc 09, screen 2).
 *
 * Three panes: specification, the record, and live state. The centre pane is
 * the mechanical ledger for now; Phase 2 replaces it with the brief.
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

interface Detail {
  readonly card: Card;
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
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load(): Promise<void> {
      try {
        const response = await fetch(`/api/cards/${cardId}/detail`);
        if (!response.ok) throw new Error(`Could not load card: ${response.status}`);
        const body = (await response.json()) as Detail;
        if (!cancelled) setDetail(body);
      } catch (cause) {
        if (!cancelled) setError((cause as Error).message);
      }
    }

    void load();
    // Opening a card is the operator looking at it, which is what the unseen
    // badge is computed against.
    void fetch(`/api/cards/${cardId}/seen`, { method: 'POST' });

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

        <Rail title={`Record (${entries.length} entries, ${detail.runs.length} run(s))`}>
          <>
            {entries.length === 0 ? (
              <p className="text-dim">
                Nothing recorded yet. This is the mechanical ledger; the brief arrives in Phase 2.
              </p>
            ) : (
              <ul className="flex flex-col gap-2">
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
                      <div className="mt-0.5 font-mono text-[11px] text-dim">{entry.detail}</div>
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
                </li>
              ))}
            </ul>
          )}
        </Rail>
      </div>
    </div>
  );
}
