import type { ReactElement } from 'react';

import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Play, Robot, Stop } from '@phosphor-icons/react';

import type { Card } from './api.js';

/**
 * One card at rest (doc 09).
 *
 * Facts about a card are chips. A chip is neutral unless the fact it carries
 * is one that wants a person - that is the rule the whole board runs on, and
 * it is why a column of finished work is grey and the one blocked card is not.
 *
 * A column already says what stage a card is at. What it cannot say is how
 * long the card has been sitting there while nobody watched, which is the rule
 * along the bottom edge and the reason this product exists.
 */

const STATUS_LABEL: Record<Card['status'], string> = {
  idle: 'Idle',
  queued: 'Queued',
  running: 'Running',
  'awaiting-review': 'Needs review',
  blocked: 'Blocked',
  done: 'Done',
  abandoned: 'Abandoned',
};

/** Only the states that want a person take colour. */
function statusTone(status: Card['status']): string {
  if (status === 'blocked') return 'chip-danger';
  if (status === 'awaiting-review') return 'chip-attention';
  if (status === 'running') return 'chip-info';
  return '';
}

const DAY = 24 * 60 * 60 * 1000;

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

  // What is left to configure. A finished or abandoned card will not run
  // again, so which model it would use and what would constrain it are
  // answers to a question nobody is asking.
  const configurable = !terminal && card.status !== 'abandoned' && card.mergedAt === null;

  const since = Date.now() - card.updatedAt;
  const waiting = isWaiting(card);
  // Full at a week. Past that the rule stops growing and the tooltip carries
  // it: a bar that kept extending would say "very old" for everything old.
  const waited = Math.min(1, since / (7 * DAY));
  const stale = waiting && since > 2 * DAY;

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`group relative shrink-0 overflow-hidden rounded-md border bg-surface transition-colors ${
        isDragging
          ? 'border-brand opacity-70'
          : 'border-line hover:border-edge focus-within:border-edge'
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
          {/* A fixed gutter, so titles line up down the column whether or not a
              card has a number. */}
          <span
            className={`w-4 shrink-0 pt-px text-right text-[12.5px] ${
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

          {/* Two lines, always. A card three lines tall beside one that is one
              line makes a column nobody can scan; the rest is a hover away. */}
          <span
            className="line-clamp-2 min-h-[2.75em] min-w-0 flex-1 font-medium leading-snug text-ink"
            title={card.title}
          >
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

        {/* One line of chips, never two. A card that grows a row because it
            carries one more fact is a card whose height depends on its
            configuration, and a column of those cannot be scanned. What does
            not fit is clipped, and the tooltips carry it. */}
        <div className="mt-2 flex items-center gap-1 overflow-hidden pl-6">
          {/* "Merged" replaces "Done" rather than sitting beside it: a card the
              board merged and a card the operator marked finished are different
              outcomes, and showing both words would restate the ambiguity. */}
          {card.mergedAt === null ? (
            <span className={`chip ${statusTone(card.status)}`}>{STATUS_LABEL[card.status]}</span>
          ) : (
            <span
              className="chip chip-ok"
              title={`Merged into ${card.mergedInto ?? 'the target branch'} from ${
                card.mergedBranch ?? 'its branch'
              } on ${new Date(card.mergedAt).toLocaleString()}`}
            >
              Merged
            </span>
          )}

          {/* Priority changes what runs next. `normal` shows nothing: a chip on
              every card conveys no ordering at all. */}
          {card.priority === 'normal' ? null : (
            <span
              className={`chip ${card.priority === 'high' ? 'chip-danger' : ''}`}
              title={
                card.priority === 'high'
                  ? 'Dispatched before normal and low cards in the same column.'
                  : 'Dispatched after normal cards in the same column.'
              }
            >
              {card.priority === 'high' ? 'High' : 'Low'}
            </span>
          )}

          {card.goalCondition === null ? (
            <span
              className="chip chip-danger"
              title="Cannot be dispatched without a goal condition"
            >
              No goal
            </span>
          ) : null}

          {terminal || !card.looksFinished ? null : (
            /* Shown on the tile because a signal only visible after opening a
               card is a signal nobody sees: an operator with fifteen cards will
               not open fifteen cards. */
            <span
              className="chip chip-attention"
              title="Every file this card names already exists and it has never run. Open it to see why the board thinks so."
            >
              May be done
            </span>
          )}

          {/* A finished card does not need to be told which model ran it or what
              constrained it. Those answer "how will this go", and it has gone. */}
          {configurable ? (
            <span
              className={`chip inline-flex items-center gap-1 ${
                card.agentProvider === 'codex' ? 'text-[#f59a4a]' : ''
              }`}
              title={`This card will run with ${card.agentProvider === 'codex' ? 'Codex' : 'Claude Code'}`}
            >
              <Robot size={13} weight="fill" aria-hidden />
              {card.agentProvider === 'codex' ? 'Codex' : 'Claude'}
              {card.agentModel === null ? '' : ` · ${card.agentModel}`}
            </span>
          ) : null}

          {configurable && hard + advisory > 0 ? (
            <span
              className="chip"
              title={card.guardrailDetail
                .map((rail) => `${rail.text} (${rail.enforcement})`)
                .join('\n')}
            >
              {/* Split, never a single total: a guardrail believed to be
                  enforced but which is not is worse than none (R10). */}
              {hard} hard · {advisory} advisory
            </span>
          ) : null}

          {/* Stopping an agent is always visible. Starting one appears on hover
              or focus, because a column of idle cards each offering a button is
              a column of buttons. */}
          {card.status === 'running' ? (
            <button
              type="button"
              className="ml-auto inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[12.5px] font-medium text-danger transition-colors hover:bg-danger-tint"
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                onCancel(card);
              }}
            >
              <Stop size={12} weight="fill" aria-hidden />
              Stop
            </button>
          ) : runnable ? (
            <button
              type="button"
              className="ml-auto inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[12.5px] font-medium text-ok opacity-0 transition-opacity hover:bg-ok-tint focus-visible:opacity-100 group-hover:opacity-100"
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                onRun(card);
              }}
              title={`Dispatch a ${card.agentProvider === 'codex' ? 'Codex' : 'Claude Code'} session for this card`}
            >
              <Play size={12} weight="fill" aria-hidden />
              Run
            </button>
          ) : null}
        </div>
      </div>

      {/* How long this has sat. The column says what stage a card is at; only
          this says it has been at that stage since Tuesday. */}
      {waiting ? (
        <div
          className="absolute inset-x-0 bottom-0 h-0.5 bg-line"
          title={`Last changed ${waitedFor(since)}`}
        >
          <div
            className={`h-0.5 ${stale ? 'bg-attention' : 'bg-edge'}`}
            style={{ width: `${String(Math.round(waited * 100))}%` }}
          />
        </div>
      ) : null}
    </li>
  );
}
