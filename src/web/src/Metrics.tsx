import { useEffect, useState, type ReactElement } from 'react';
import { X } from '@phosphor-icons/react';

import { Panel } from './Panel.js';

import { api } from './api.js';

/**
 * The numbers (T59, T60, T74).
 *
 * The board answers what is happening now. These are the questions that only
 * have answers over weeks: is this getting faster, what actually breaks, and
 * what has it cost. Every fact behind them has been recorded for months and
 * nothing read them back until there was a screen.
 */

interface DaySpend {
  readonly day: string;
  readonly tokens: number;
  readonly costUsd: number | null;
  readonly runs: number;
}

interface MetricsBody {
  readonly throughput: { created: number; merged: number; medianLeadTimeMs: number | null };
  readonly failures: readonly { reason: string; cards: number }[];
  readonly neverRan: number;
  readonly spendByDay: readonly DaySpend[];
  readonly notes: readonly string[];
}

function short(tokens: number): string {
  return tokens < 1_000 ? String(tokens) : `${String(Math.round(tokens / 1_000))}k`;
}

export function Metrics({
  boardId,
  onClose,
}: {
  boardId: string;
  onClose: () => void;
}): ReactElement {
  const [body, setBody] = useState<MetricsBody | null>(null);

  useEffect(() => {
    let cancelled = false;

    void api.metrics<MetricsBody>(boardId).then((loaded) => {
      if (!cancelled) setBody(loaded);
    });

    return () => {
      cancelled = true;
    };
  }, [boardId]);

  const busiest = Math.max(1, ...(body?.spendByDay ?? []).map((day) => day.tokens));

  return (
    <Panel title="The numbers: throughput, failures and spend" onClose={onClose}>
      <header className="flex items-baseline gap-3 border-b border-line bg-surface px-4 py-2.5">
        <h2 className="text-[14.5px] font-semibold tracking-tight text-ink">The numbers</h2>
        <span className="text-[12.5px] text-dim">Last thirty days</span>
        <button
          type="button"
          aria-label="Close"
          className="ml-auto inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-dim transition-colors hover:bg-well hover:text-ink"
          onClick={onClose}
        >
          <X size={14} aria-hidden />
          Close
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
        <div className="mx-auto w-full max-w-3xl">
          {body === null ? (
            <p className="text-dim">Reading the board.</p>
          ) : (
            <>
              {/* The prose first. Every one of these carries a caveat the number
                alone would drop - a lead time over two cards, a total over the
                days that reported a price. */}
              {body.notes.map((note) => (
                <p key={note} className="mb-1 text-dim">
                  {note}
                </p>
              ))}

              {body.spendByDay.length === 0 ? null : (
                <div className="mt-4">
                  <h3 className="mb-1.5 eyebrow">Tokens by day</h3>
                  <ul className="flex flex-col gap-0.5 text-[12.5px]">
                    {body.spendByDay.map((day) => (
                      <li key={day.day} className="flex items-baseline gap-2">
                        <span className="w-24 text-dim">{day.day}</span>
                        {/* Bars rather than a chart library: the shape is the
                          only thing being read, and one dependency for it
                          would be a dependency for one screen. */}
                        <span
                          className="inline-block h-2 bg-brand/40"
                          style={{ width: `${String(Math.round((day.tokens / busiest) * 60))}%` }}
                        />
                        <span className="text-ink">{short(day.tokens)}</span>
                        <span className="text-dim">
                          {/* Said as unpriced rather than as free. */}
                          {day.costUsd === null ? 'unpriced' : `$${day.costUsd.toFixed(2)}`}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {body.failures.length === 0 ? null : (
                <div className="mt-4">
                  <h3 className="mb-1.5 eyebrow">How runs ended</h3>
                  <ul className="flex flex-col gap-0.5 text-[12.5px]">
                    {body.failures.map((failure) => (
                      <li key={failure.reason} className="text-dim">
                        <span className="text-ink">{failure.reason}</span> · {failure.cards} card(s)
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </Panel>
  );
}
