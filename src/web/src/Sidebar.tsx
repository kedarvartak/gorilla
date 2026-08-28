import type { ComponentType, ReactElement, ReactNode } from 'react';

import {
  ChartBar,
  Kanban,
  ListNumbers,
  Pulse,
  Scales,
  SunHorizon,
  type IconProps,
} from '@phosphor-icons/react';

import { Logo } from './Logo.js';

/**
 * The rail (doc 09).
 *
 * The header used to carry sixteen controls in two wrapped rows: the board's
 * views, its dispatch settings, its counters and its composer, all at the same
 * weight. Nothing was findable because nothing was ranked.
 *
 * The views move here, where they are a short list that does not change, and
 * the header keeps only what changes while you watch.
 *
 * Collapsed to an icon strip by default, because "does not change" is also an
 * argument against spending 208 pixels on it. The board is the part with the
 * content in it and the part that scrolls sideways when five columns do not
 * fit, so the width belongs there.
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

/*
 * The two widths - `w-14` collapsed, `w-52` open - are written out literally
 * everywhere they are used, and deliberately not lifted into constants.
 *
 * Tailwind reads the source as text. A class assembled as `hover:${OPEN}` never
 * appears in the file, so the rule is never generated, and the panel silently
 * refuses to open with nothing in the build to explain why. The duplication is
 * the price of the scanner seeing them at all.
 *
 * The strip is what the layout reserves; the panel is absolutely positioned and
 * grows over the board rather than pushing it. A rail that reflowed five
 * columns every time the pointer crossed it would be worse than one that never
 * collapsed at all - the cards would move out from under the cursor.
 */

/**
 * A label that is present for a screen reader while invisible to the eye.
 *
 * Not `sr-only`: swapping the text in and out would mean the accessible name
 * changes with the pointer, and the buttons would be unreachable by voice while
 * collapsed. It stays in the tree at full size and is clipped by the panel,
 * with the fade only there to keep a sliver of a word from showing at the cut.
 */
function Label({ children }: { children: ReactNode }): ReactElement {
  return (
    <span className="whitespace-nowrap opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100">
      {children}
    </span>
  );
}

export function Sidebar({
  boardName,
  view,
  live,
  spent,
  activityOpen,
  onSelect,
  onToggleActivity,
}: {
  /** Only a tooltip now. It was a line of its own and said nothing the rest of
   *  the screen did not: this board is called after its directory, so the
   *  product's name was followed by the word "kanban". */
  boardName: string;
  view: View;
  live: boolean;
  /** Today's spend, already worded by the server. */
  spent: string | null;
  activityOpen: boolean;
  onSelect: (view: View) => void;
  onToggleActivity: () => void;
}): ReactElement {
  const item =
    'flex w-full items-center rounded-md py-1.5 text-left transition-colors ' +
    'focus-visible:outline-offset-[-2px]';
  // A fixed box so every glyph lands on the strip's centre line, collapsed or
  // open. Without it the icons drift left as the panel grows.
  const glyph = 'grid w-10 shrink-0 place-items-center';

  return (
    <nav aria-label="Views" className="relative w-14 shrink-0">
      <div className="group absolute inset-y-0 left-0 z-40 flex w-14 flex-col overflow-hidden border-r border-line bg-surface transition-[width,box-shadow] duration-150 hover:w-52 hover:shadow-xl focus-within:w-52 focus-within:shadow-xl">
        <div className="flex items-center border-b border-line py-3.5" title={boardName}>
          <span className={`${glyph} text-brand`}>
            <Logo size={22} />
          </span>
          <Label>
            <span className="text-[15px] font-semibold tracking-tight text-ink">Gorilla</span>
          </Label>
        </div>

        <ul className="flex flex-1 flex-col gap-0.5 p-2">
          {VIEWS.map((entry) => (
            <li key={entry.id}>
              <button
                type="button"
                title={entry.hint}
                aria-current={view === entry.id ? 'page' : undefined}
                className={`${item} ${
                  view === entry.id
                    ? 'bg-brand-tint font-medium text-brand'
                    : 'text-dim hover:bg-well hover:text-ink'
                }`}
                onClick={() => onSelect(entry.id)}
              >
                <span className={glyph}>
                  <entry.Icon size={16} aria-hidden />
                </span>
                <Label>{entry.label}</Label>
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
              className={`${item} ${
                activityOpen
                  ? 'bg-well font-medium text-ink'
                  : 'text-dim hover:bg-well hover:text-ink'
              }`}
              onClick={onToggleActivity}
            >
              <span className={glyph}>
                <Pulse size={16} aria-hidden />
              </span>
              <Label>Activity</Label>
            </button>
          </li>
        </ul>

        <div className="border-t border-line py-3 text-[12.5px]">
          {/* The two facts worth knowing without asking: whether the board is
              still hearing from its agents, and what the day has cost. The dot
              survives the collapse, because "has this stopped receiving
              anything" is the one of the two you need at a glance. */}
          <div
            className="flex items-center"
            title={live ? 'Receiving events' : 'Not receiving events'}
          >
            <span className={glyph}>
              <span
                className={`size-1.5 rounded-full ${live ? 'bg-ok' : 'bg-danger'}`}
                aria-hidden
              />
            </span>
            <Label>
              <span className="text-dim">{live ? 'Live' : 'Offline'}</span>
            </Label>
          </div>
          {spent === null ? null : (
            <div className="mt-1 flex items-center">
              <span className={glyph} aria-hidden />
              <Label>
                <span className="text-faint">{spent}</span>
              </Label>
            </div>
          )}
        </div>
      </div>
    </nav>
  );
}
