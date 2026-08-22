import type { ComponentType, ReactElement } from 'react';

import {
  ChartBar,
  Kanban,
  ListNumbers,
  Pulse,
  Scales,
  SunHorizon,
  type IconProps,
} from '@phosphor-icons/react';

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

const VIEWS: readonly {
  id: View;
  label: string;
  hint: string;
  Icon: ComponentType<IconProps>;
}[] = [
  { id: 'board', label: 'Board', hint: 'Every card, in its column', Icon: Kanban },
  {
    id: 'digest',
    label: 'Digest',
    hint: 'What changed while you were away, and what was already waiting',
    // A sunrise: that is when this screen is read, and what it reports on.
    Icon: SunHorizon,
  },
  {
    id: 'order',
    label: 'Order',
    hint: 'What runs next, and what each card is waiting for',
    Icon: ListNumbers,
  },
  {
    id: 'numbers',
    label: 'Numbers',
    hint: 'Throughput, what actually breaks, and what each day cost',
    Icon: ChartBar,
  },
  {
    id: 'rules',
    label: 'Rules',
    hint: 'Rules handed to every card this board dispatches',
    Icon: Scales,
  },
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
    <nav aria-label="Views" className="flex w-52 shrink-0 flex-col border-r border-line bg-surface">
      <div className="border-b border-line px-4 py-3.5">
        <div className="text-[14px] font-semibold tracking-tight text-ink">Gorilla</div>
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
              className={`flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left transition-colors ${
                view === entry.id
                  ? 'bg-brand-tint font-medium text-brand'
                  : 'text-dim hover:bg-well hover:text-ink'
              }`}
              onClick={() => onSelect(entry.id)}
            >
              <entry.Icon size={16} aria-hidden />
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
            className={`flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left transition-colors ${
              activityOpen
                ? 'bg-well font-medium text-ink'
                : 'text-dim hover:bg-well hover:text-ink'
            }`}
            onClick={onToggleActivity}
          >
            <Pulse size={16} aria-hidden />
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
          <span className={`size-1.5 rounded-full ${live ? 'bg-ok' : 'bg-danger'}`} aria-hidden />
          <span className="text-dim">{live ? 'Live' : 'Offline'}</span>
        </div>
        {spent === null ? null : <div className="mt-1 text-faint">{spent}</div>}
      </div>
    </nav>
  );
}
