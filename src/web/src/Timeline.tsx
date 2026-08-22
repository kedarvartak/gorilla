import { useCallback, useEffect, useState, type ReactElement } from 'react';

import { api } from './api.js';

/**
 * The run timeline (doc 09, screen 3).
 *
 * Reached from a card, never the default view: the unit of presentation is the
 * task, and an event list is volume rather than synthesis (P3 of doc 04).
 *
 * Compaction is the anchor. A full-width marker shows where the agent's memory
 * of everything above it became a summary - which is the single most useful
 * thing this screen says, because it is invisible everywhere else.
 */

interface Entry {
  readonly id: number;
  readonly seq: number;
  readonly event: string;
  readonly at: number;
  readonly toolName: string | null;
  readonly agentId: string | null;
  readonly agentType: string | null;
  readonly triggerReason: string | null;
  readonly isCompaction: boolean;
  readonly isTurnBoundary: boolean;
}

interface Facets {
  readonly events: readonly { name: string; n: number }[];
  readonly tools: readonly { name: string; n: number }[];
}

const PAGE = 200;

function time(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, { hour12: false });
}

export function Timeline({ runId, onClose }: { runId: string; onClose: () => void }): ReactElement {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [facets, setFacets] = useState<Facets>({ events: [], tools: [] });
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [after, setAfter] = useState(0);
  const [eventFilter, setEventFilter] = useState('');
  const [toolFilter, setToolFilter] = useState('');
  const [density, setDensity] = useState<string | null>(null);
  const [repeats, setRepeats] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<{ text?: string; note?: string } | null>(null);

  const load = useCallback(
    async (from: number, replace: boolean) => {
      const params = new URLSearchParams({ limit: String(PAGE), after: String(from) });
      if (eventFilter !== '') params.set('event', eventFilter);
      if (toolFilter !== '') params.set('tool', toolFilter);

      const body = await api.runTimeline<{
        total: number;
        entries: Entry[];
        nextAfter: number;
        hasMore: boolean;
        density?: { note: string };
        repeatNote?: string | null;
      }>(runId, params);

      // Null rather than a throw: a timeline page that will not load leaves
      // the pane showing what it already had, which beats emptying it.
      if (body === null) return;

      setDensity(body.density?.note ?? null);
      setRepeats(body.repeatNote ?? null);
      setTotal(body.total);
      setHasMore(body.hasMore);
      setAfter(body.nextAfter);
      setEntries((current) => (replace ? body.entries : [...current, ...body.entries]));
    },
    [runId, eventFilter, toolFilter],
  );

  useEffect(() => {
    void load(0, true);
    void api.runFacets<Facets>(runId).then((facets) => {
      if (facets !== null) setFacets(facets);
    });
  }, [load, runId]);

  const compactions = entries.filter((entry) => entry.event === 'PreCompact').length;

  return (
    <div className="flex h-[60%] flex-col border-t border-line bg-panel">
      <header className="flex flex-wrap items-baseline gap-x-4 gap-y-1 border-b border-line px-4 py-2">
        <h2 className="font-mono text-[11px] uppercase tracking-wider text-dim">Timeline</h2>
        <span className="text-dim">
          showing <b className="text-text">{entries.length}</b> of{' '}
          <b className="text-text">{total}</b>
        </span>
        {/* Where the time went, over the events on screen. A list of evenly
            spaced rows says a run happened and nothing about its shape. */}
        {density === null ? null : <span className="text-dim">{density}</span>}
        {/* A denial storm renders as eighty rows that each look like work.
            This is the one line that says they were all the same call. */}
        {repeats === null ? null : <span className="text-warn">{repeats}</span>}

        {/* The reasoning, which the events do not carry. The board has stored
            this path since Phase 0 and never opened it. */}
        <button
          type="button"
          className="ml-auto rounded border border-line px-2 py-0.5 font-mono text-[11px] text-dim hover:text-text"
          onClick={() => {
            if (transcript !== null) {
              setTranscript(null);
              return;
            }
            void api
              .runTranscript<{ available: boolean; text?: string; note?: string }>(runId)
              .then((body) =>
                setTranscript(
                  body === null
                    ? { note: 'The transcript could not be read.' }
                    : body.available
                      ? { text: body.text ?? '' }
                      : { note: body.note ?? 'No transcript.' },
                ),
              );
          }}
        >
          {transcript === null ? 'transcript' : 'events'}
        </button>
        {compactions > 0 ? (
          <span className="text-warn">
            {compactions} compaction{compactions === 1 ? '' : 's'}
          </span>
        ) : null}

        <select
          className="rounded border border-line bg-panel-2 px-1 py-0.5 text-text"
          value={eventFilter}
          onChange={(changed) => setEventFilter(changed.target.value)}
        >
          <option value="">all events</option>
          {facets.events.map((facet) => (
            <option key={facet.name} value={facet.name}>
              {facet.name} ({facet.n})
            </option>
          ))}
        </select>

        <select
          className="rounded border border-line bg-panel-2 px-1 py-0.5 text-text"
          value={toolFilter}
          onChange={(changed) => setToolFilter(changed.target.value)}
        >
          <option value="">all tools</option>
          {facets.tools.map((facet) => (
            <option key={facet.name} value={facet.name}>
              {facet.name} ({facet.n})
            </option>
          ))}
        </select>

        <button
          type="button"
          className="ml-auto rounded border border-line px-2 py-0.5 text-dim hover:text-text"
          onClick={onClose}
        >
          close
        </button>
      </header>

      {transcript === null ? null : (
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-2">
          {transcript.text === undefined ? (
            <p className="text-dim">{transcript.note}</p>
          ) : (
            <pre className="whitespace-pre-wrap font-mono text-[11px] text-dim">
              {transcript.text === '' ? 'The transcript is empty.' : transcript.text}
            </pre>
          )}
        </div>
      )}

      <ol
        className={`min-h-0 flex-1 overflow-y-auto px-4 py-2 font-mono text-[11px] ${
          transcript === null ? '' : 'hidden'
        }`}
      >
        {entries.map((entry) =>
          entry.event === 'PreCompact' ? (
            <li key={entry.id} className="my-2 flex items-center gap-2 text-warn">
              <span className="h-px flex-1 bg-warn/40" />
              {/* The agent's memory of everything above this line is now a
                  summary. Nothing else in the interface says so. */}
              <span className="whitespace-nowrap">
                context compacted here ({entry.triggerReason ?? 'unknown trigger'})
              </span>
              <span className="h-px flex-1 bg-warn/40" />
            </li>
          ) : (
            <li
              key={entry.id}
              className={`flex gap-3 py-0.5 ${
                entry.isTurnBoundary ? 'border-t border-line pt-1.5' : ''
              } ${entry.agentId === null ? '' : 'pl-6'}`}
            >
              <span className="w-8 shrink-0 text-right text-dim">{entry.seq}</span>
              <span className="w-16 shrink-0 text-dim">{time(entry.at)}</span>
              <span className={entry.isCompaction ? 'text-warn' : 'text-accent'}>
                {entry.event}
              </span>
              {entry.toolName === null ? null : <span className="text-text">{entry.toolName}</span>}
              {entry.agentId === null ? null : (
                <span className="text-info" title={`Subagent ${entry.agentId}`}>
                  {entry.agentType ?? 'subagent'}
                </span>
              )}
            </li>
          ),
        )}
      </ol>

      {hasMore ? (
        <button
          type="button"
          className="border-t border-line py-1.5 text-dim hover:text-text"
          onClick={() => void load(after, false)}
        >
          Load more
        </button>
      ) : null}
    </div>
  );
}
