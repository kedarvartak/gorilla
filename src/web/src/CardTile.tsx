import type { ReactElement } from 'react';

import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Play, Stop } from '@phosphor-icons/react';

import claudeLogo from './assets/claude-color.webp';
import codexLogo from './assets/codex.webp';

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
 *
 * The anchor is the dispatch plate: the assigned agent's own mark, on a plate
 * tinted to that agent, with the position in the running order set beneath it.
 * On a board where two providers run, which one holds a card decides what the
 * work will cost and what it can be trusted with, and that is not something to
 * learn by opening the card.
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

const AGENTS = {
  claude: {
    name: 'Claude Code',
    logo: claudeLogo,
    plate: 'border-claude/25 bg-claude-plate',
  },
  codex: { name: 'Codex', logo: codexLogo, plate: 'border-codex/20 bg-codex-plate' },
} as const;

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

  const agent = card.agentProvider === 'codex' ? AGENTS.codex : AGENTS.claude;

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
      className={`group relative shrink-0 overflow-hidden rounded-lg border bg-surface transition-colors ${
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
      aria-label={`${card.title}, ${STATUS_LABEL[card.status]}, assigned to ${agent.name}${
        card.priority === 'normal' ? '' : `, ${card.priority} priority`
      }${unseen ? ', unseen changes' : ''}. Press o to open${runnable ? ', d to dispatch' : ''}.`}
    >
      <div className="flex gap-3 px-3.5 pb-3 pt-3.5">
        {/* The dispatch plate. Fixed width, so titles line up down the column
            whether or not a card has a position in the order. */}
        <div className="flex w-10 shrink-0 flex-col items-center gap-1">
          <span
            className={`flex size-10 items-center justify-center rounded-lg border ${agent.plate} ${
              card.status === 'running' ? 'ring-2 ring-info ring-offset-1' : ''
            }`}
            title={
              card.status === 'running'
                ? `${agent.name} is running this card now`
                : `Assigned to ${agent.name}`
            }
          >
            <img src={agent.logo} alt={agent.name} className="size-7 object-contain" />
          </span>

          {/* Mono, because it is an ordinal the board computed rather than a
              word anybody wrote. */}
          {card.rank === null ? null : (
            <span
              className={`font-mono text-[11.5px] leading-none ${
                card.rankBlocked ? 'text-faint' : 'text-dim'
              }`}
              title={
                card.rankBlocked
                  ? `${String(card.rank)} in the order, but blocked until its dependencies finish`
                  : `${String(card.rank)} in the order to work in`
              }
            >
              {card.rank}
            </span>
          )}
        </div>

        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-start gap-2">
            {/* Two lines, always. A card three lines tall beside one that is
                one line makes a column nobody can scan; the rest is a hover
                away. */}
            <span
              className="line-clamp-2 min-h-[2.6em] min-w-0 flex-1 text-[15.5px] font-semibold leading-[1.3] text-ink"
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

          {/* Enough context to recognise the work. The detail pane still owns
              the specification. */}
          <p className="mt-1.5 line-clamp-2 min-h-[2.6em] text-[12.5px] leading-[1.3] text-dim">
            {card.body.trim() === '' ? (card.goalCondition ?? 'No description yet.') : card.body}
          </p>
        </div>
      </div>

      <div className="flex items-center gap-2 border-t border-line px-3.5 py-2.5">
        {/* Two groups, and the left one clips. Allowed to wrap, a card whose
            chips and Run button together overran the width grew a second row
            and stood taller than every card beside it, which is the one thing
            a column of cards cannot afford. */}
        <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
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

          {/* The guardrail count used to print here as "2 hard · 3 advisory".
              It was the longest chip on the tile and the one nobody acted on
              from the board; the specification tab now states each rail in
              full. */}
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {/* Stopping an agent is always visible. Starting one appears on hover
            or focus, because a column of idle cards each offering a button is
            a column of buttons. */}
          {card.status === 'running' ? (
            <button
              type="button"
              className="inline-flex items-center gap-1 rounded-md border border-danger/30 px-2.5 py-1 text-[12.5px] font-medium text-danger transition-colors hover:bg-danger-tint"
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
              className="inline-flex items-center gap-1 rounded-md border border-ok/30 px-2.5 py-1 text-[12.5px] font-medium text-ok transition-colors hover:bg-ok-tint"
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                onRun(card);
              }}
              title={`Dispatch a ${agent.name} session for this card`}
            >
              <Play size={12} weight="fill" aria-hidden />
              Run
            </button>
          ) : null}

          {/* The elapsed time yields to the button rather than squeezing the
              status chip out of the row. Nothing is lost: the rule along the
              bottom edge is the same fact drawn, and it carries the phrase in
              its tooltip. */}
          {card.status === 'running' || runnable ? null : (
            <span
              className="whitespace-nowrap text-[11.5px] text-faint"
              title={`Last changed ${waitedFor(since)}`}
            >
              {waiting ? waitedFor(since) : 'updated'}
            </span>
          )}
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
