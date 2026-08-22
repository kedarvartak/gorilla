import type { ReactElement } from 'react';

import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

import type { Card } from './api.js';

/**
 * One card at rest (doc 09).
 *
 * A column already says what stage a card is at, so the tile does not repeat
 * it in colour. What the column cannot say is the thing this product is
 * actually about: how long the card has been sitting there while nobody
 * watched. That is the rule along the bottom edge.
 *
 * The unseen mark is the board's primary call to action, so it is on the left
 * edge where a column of cards can be scanned in one movement rather than read
 * one at a time.
 */

const STATUS_LABEL: Record<Card['status'], string> = {
  idle: 'idle',
  queued: 'queued',
  running: 'running',
  'awaiting-review': 'needs review',
  blocked: 'blocked',
  done: 'done',
  abandoned: 'abandoned',
};

const DAY = 24 * 60 * 60 * 1000;

/** Cards that are finished are not waiting for anything. */
function isWaiting(card: Card): boolean {
  return card.status !== 'done' && card.status !== 'abandoned' && card.mergedAt === null;
}

function waitedFor(since: number): string {
  const hours = since / (60 * 60 * 1000);
  if (hours < 1) return 'under an hour ago';
  if (hours < 48) return `${String(Math.round(hours))} hours ago`;
  return `${String(Math.round(hours / 24))} days ago`;
}

export interface CardTileProps {
  readonly card: Card;
  readonly unseen: boolean;
  /** Eligible for dispatch, as the server computes it. */
  readonly runnable: boolean;
  /** In a terminal column. What a finished card needs shown is not the same. */
  readonly terminal: boolean;
  readonly onOpen: (card: Card) => void;
  readonly onRun: (card: Card) => void;
  readonly onCancel: (card: Card) => void;
}

export function CardTile({
  card,
  unseen,
  runnable,
  terminal,
  onOpen,
  onRun,
  onCancel,
}: CardTileProps): ReactElement {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: card.id,
  });

  const hard = card.guardrailDetail.filter((rail) => rail.enforcement === 'hard').length;
  const advisory = card.guardrailDetail.filter((rail) => rail.enforcement === 'advisory').length;

  const since = Date.now() - card.updatedAt;
  const waiting = isWaiting(card);
  // Full at a week. Past that the bar stops growing and the number in the
  // tooltip carries it: a rule that kept extending would say "very old" for
  // everything old, which is not a distinction worth drawing.
  const waited = Math.min(1, since / (7 * DAY));
  const stale = waiting && since > 2 * DAY;

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`group relative shrink-0 overflow-hidden rounded-md border bg-panel-2 transition-colors ${
        isDragging
          ? 'border-accent/60 opacity-60'
          : 'border-edge/70 hover:border-edge focus-within:border-edge'
      }`}
      {...attributes}
      {...listeners}
      onDoubleClick={() => onOpen(card)}
      onKeyDown={(event) => {
        // Not Enter or Space: the drag sensor owns both, and taking one would
        // make a card impossible to move without a mouse in exchange for
        // making it possible to open (T78).
        if (event.key === 'o') {
          event.preventDefault();
          onOpen(card);
          return;
        }
        if (event.key === 'd' && runnable) {
          event.preventDefault();
          onRun(card);
        }
      }}
      aria-label={`${card.title}, ${STATUS_LABEL[card.status]}${
        card.priority === 'normal' ? '' : `, ${card.priority} priority`
      }${unseen ? ', unseen changes' : ''}. Press o to open${runnable ? ', d to dispatch' : ''}.`}
    >
      <div className="px-3 py-2.5">
        <div className="flex items-start gap-2">
          {/* A fixed gutter, so titles line up down the column whether or not
              a card has a number. Inline, they did not. */}
          <span
            className={`w-5 shrink-0 pt-px text-right text-[11px] tabular-nums ${
              card.rankBlocked ? 'text-faint' : 'text-dim'
            }`}
            title={
              card.rank === null
                ? undefined
                : card.rankBlocked
                  ? `${String(card.rank)} in the order, but blocked until its dependencies finish`
                  : `${String(card.rank)} in the order to work in`
            }
          >
            {card.rank ?? ''}
          </span>

          {/* Two lines, always. A card that is three lines tall next to one
              that is one line makes a column that cannot be scanned, and the
              rest of the title is a hover away. */}
          <span
            className="line-clamp-2 min-h-[2.75em] min-w-0 flex-1 leading-snug text-text"
            title={card.title}
          >
            {/* Priority sits before the title because it changes what runs
                next, and the operator scans titles. `normal` shows nothing: a
                chip on every card conveys no ordering at all. */}
            {card.priority === 'normal' ? null : (
              <span
                className={`mr-1.5 align-[1px] text-[10px] font-semibold uppercase tracking-wide ${
                  card.priority === 'high' ? 'text-warn' : 'text-faint'
                }`}
                title={
                  card.priority === 'high'
                    ? 'Dispatched before normal and low cards in the same column.'
                    : 'Dispatched after normal cards in the same column.'
                }
              >
                {card.priority}
              </span>
            )}
            {card.title}
          </span>

          {unseen ? (
            <span
              className="mt-1.5 size-1.5 shrink-0 rounded-full bg-attention"
              title="Changed since you last looked"
              aria-hidden
            />
          ) : null}
        </div>

        {/* One line, always. A card whose metadata wraps to three lines in a
            narrow column is a card whose height depends on the width of the
            column it happens to be in, and a board of those has no rhythm. */}
        <div className="mt-1.5 flex items-center gap-2.5 overflow-hidden pl-7 text-[11px] whitespace-nowrap text-faint">
          {/* "merged" replaces "done" rather than sitting beside it: a card the
              board merged and a card the operator marked finished are different
              outcomes, and showing both words would restate the ambiguity. */}
          {card.mergedAt === null ? (
            <span className={card.status === 'blocked' ? 'text-warn' : 'text-dim'}>
              {STATUS_LABEL[card.status]}
            </span>
          ) : (
            <span
              className="text-ok"
              title={`Merged into ${card.mergedInto ?? 'the target branch'} from ${
                card.mergedBranch ?? 'its branch'
              } on ${new Date(card.mergedAt).toLocaleString()}`}
            >
              merged
            </span>
          )}

          {/* A finished card does not need to be told which model ran it or
              what constrained it. Those answer "how will this go", and it has
              already gone. */}
          {terminal || card.agentModel === null ? null : <span>{card.agentModel}</span>}

          {!terminal && hard + advisory > 0 ? (
            <span
              className="min-w-0 truncate"
              title={card.guardrailDetail
                .map((rail) => `${rail.text} (${rail.enforcement})`)
                .join('\n')}
            >
              {/* Split, never a single total: a guardrail believed to be
                  enforced but which is not is worse than none (R10). */}
              {hard} hard, {advisory} advisory
            </span>
          ) : null}

          {terminal || !card.looksFinished ? null : (
            /* Shown on the tile because a signal only visible after opening a
               card is a signal nobody sees: an operator with fifteen cards will
               not open fifteen cards. */
            <span
              className="text-attention"
              title="Every file this card names already exists and it has never run. Open it to see why the board thinks so."
            >
              may be done
            </span>
          )}

          {card.goalCondition === null ? (
            <span className="text-warn" title="Cannot be dispatched without a goal condition">
              no goal
            </span>
          ) : null}

          {/* Starting and stopping an agent is the primary action on a card, so
              it lives on the card rather than behind a menu. Stop is always
              visible; run appears on hover or focus, because a column of idle
              cards each offering a button is a column of buttons. */}
          {card.status === 'running' ? (
            <button
              type="button"
              className="ml-auto rounded-sm border border-warn/40 px-1.5 py-px text-warn transition-colors hover:bg-warn/10"
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                onCancel(card);
              }}
            >
              stop
            </button>
          ) : runnable ? (
            <button
              type="button"
              className="ml-auto rounded-sm border border-ok/40 px-1.5 py-px text-ok opacity-0 transition-opacity hover:bg-ok/10 focus-visible:opacity-100 group-hover:opacity-100"
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                onRun(card);
              }}
              title="Dispatch a Claude Code session for this card"
            >
              run
            </button>
          ) : null}
        </div>
      </div>

      {/* How long this has sat. The column says what stage a card is at; only
          this says that it has been at that stage since Tuesday, which is the
          fact an overnight board exists to surface. */}
      {waiting ? (
        <div
          className="absolute inset-x-0 bottom-0 h-px bg-line"
          title={`Last changed ${waitedFor(since)}`}
        >
          <div
            className={`h-px ${stale ? 'bg-attention/70' : 'bg-edge'}`}
            style={{ width: `${String(Math.round(waited * 100))}%` }}
          />
        </div>
      ) : null}
    </li>
  );
}
