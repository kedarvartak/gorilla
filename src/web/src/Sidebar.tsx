import type { ReactElement } from 'react';

/**
 * The rail (doc 09).
 *
 * The header used to carry sixteen controls in two wrapped rows: the board's
 * views, its dispatch settings, its counters and its composer, all at the same
 * weight. Nothing was findable because nothing was ranked.
 *
 * The views move here, where they are a short list that does not change, and
 * the header keeps only what changes while you watch.
 */

export type View = 'board' | 'digest' | 'order' | 'numbers' | 'rules';

const VIEWS: readonly { id: View; label: string; hint: string }[] = [
  { id: 'board', label: 'Board', hint: 'Every card, in its column' },
  {
    id: 'digest',
    label: 'Digest',
    hint: 'What changed while you were away, and what was already waiting',
  },
  { id: 'order', label: 'Order', hint: 'What runs next, and what each card is waiting for' },
  {
    id: 'numbers',
    label: 'Numbers',
    hint: 'Throughput, what actually breaks, and what each day cost',
  },
  { id: 'rules', label: 'Rules', hint: 'Rules handed to every card this board dispatches' },
];

export function Sidebar({
  boardName,
  view,
  live,
  spent,
  activityOpen,
  onSelect,
  onToggleActivity,
}: {
  boardName: string;
  view: View;
  live: boolean;
  /** Today's spend, already worded by the server. */
  spent: string | null;
  activityOpen: boolean;
  onSelect: (view: View) => void;
  onToggleActivity: () => void;
}): ReactElement {
  return (
    <nav aria-label="Views" className="flex w-52 shrink-0 flex-col border-r border-line bg-panel">
      <div className="border-b border-line px-4 py-3.5">
        <div className="text-[13px] font-semibold tracking-tight text-text">Gorilla</div>
        <div className="mt-0.5 truncate text-[11px] text-faint" title={boardName}>
          {boardName}
        </div>
      </div>

      <ul className="flex flex-1 flex-col gap-0.5 p-2">
        {VIEWS.map((entry) => (
          <li key={entry.id}>
            <button
              type="button"
              title={entry.hint}
              aria-current={view === entry.id ? 'page' : undefined}
              className={`w-full rounded-sm px-2.5 py-1.5 text-left transition-colors ${
                view === entry.id
                  ? 'bg-accent-soft text-text'
                  : 'text-dim hover:bg-panel-2 hover:text-text'
              }`}
              onClick={() => onSelect(entry.id)}
            >
              {entry.label}
            </button>
          </li>
        ))}
        {/* Not a view: the feed sits under the board rather than replacing
            it, because it is watched while doing something else. */}
        <li className="mt-2 border-t border-line pt-2">
          <button
            type="button"
            aria-pressed={activityOpen}
            title="A live line per hook event, under the board"
            className={`w-full rounded-sm px-2.5 py-1.5 text-left transition-colors ${
              activityOpen ? 'bg-panel-2 text-text' : 'text-dim hover:bg-panel-2 hover:text-text'
            }`}
            onClick={onToggleActivity}
          >
            Activity
          </button>
        </li>
      </ul>

      <div className="border-t border-line px-4 py-3 text-[11px]">
        {/* The two facts worth knowing without asking: whether the board is
            still hearing from its agents, and what the day has cost. */}
        <div
          className="flex items-center gap-1.5"
          title={live ? 'Receiving events' : 'Not receiving events'}
        >
          <span className={`size-1.5 rounded-full ${live ? 'bg-ok' : 'bg-warn'}`} aria-hidden />
          <span className="text-dim">{live ? 'Live' : 'Offline'}</span>
        </div>
        {spent === null ? null : <div className="mt-1 text-faint">{spent}</div>}
      </div>
    </nav>
  );
}
