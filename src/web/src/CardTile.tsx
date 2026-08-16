import type { ReactElement } from 'react';

import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

import type { Card } from './api.js';

/**
 * One card at rest (doc 09).
 *
 * The unseen badge is the board's primary call to action and is the most
 * prominent thing on any card that has one, because "something happened here
 * that you have not looked at" is the single most useful fact the board holds.
 */

const STATUS_STYLE: Record<Card['status'], { label: string; className: string }> = {
  idle: { label: 'idle', className: 'text-dim' },
  queued: { label: 'queued', className: 'text-info' },
  running: { label: 'running', className: 'text-accent' },
  'awaiting-review': { label: 'needs review', className: 'text-accent font-semibold' },
  blocked: { label: 'blocked', className: 'text-warn font-semibold' },
  done: { label: 'done', className: 'text-ok' },
  abandoned: { label: 'abandoned', className: 'text-dim line-through' },
};

export interface CardTileProps {
  readonly card: Card;
  readonly unseen: boolean;
  /** Eligible for dispatch, as the server computes it. */
  readonly runnable: boolean;
  readonly onOpen: (card: Card) => void;
  readonly onRun: (card: Card) => void;
  readonly onCancel: (card: Card) => void;
}

export function CardTile({
  card,
  unseen,
  runnable,
  onOpen,
  onRun,
  onCancel,
}: CardTileProps): ReactElement {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: card.id,
  });

  const status = STATUS_STYLE[card.status];
  const hard = card.guardrailDetail.filter((rail) => rail.enforcement === 'hard').length;
  const advisory = card.guardrailDetail.filter((rail) => rail.enforcement === 'advisory').length;

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`group rounded border bg-panel px-3 py-2 ${
        isDragging ? 'border-info opacity-60' : 'border-line hover:border-dim'
      }`}
      {...attributes}
      {...listeners}
      onDoubleClick={() => onOpen(card)}
      aria-label={`${card.title}, ${status.label}${unseen ? ', unseen changes' : ''}`}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="text-text leading-snug">{card.title}</span>
        {unseen ? (
          <span
            className="shrink-0 rounded-sm bg-accent px-1.5 text-[11px] font-semibold text-bg"
            title="Changed since you last looked"
          >
            new
          </span>
        ) : null}
      </div>

      <div className="mt-1.5 flex items-center gap-3 font-mono text-[11px]">
        <span className={status.className}>{status.label}</span>

        {card.agentModel === null ? null : <span className="text-dim">{card.agentModel}</span>}

        {hard + advisory > 0 ? (
          <span
            className="text-dim"
            title={card.guardrailDetail
              .map((rail) => `${rail.text} (${rail.enforcement})`)
              .join('\n')}
          >
            {/* Split, never a single total: a guardrail believed to be
                enforced but which is not is worse than none (R10). */}
            {hard} hard, {advisory} advisory
          </span>
        ) : null}

        {card.goalCondition === null ? (
          <span className="text-warn" title="Cannot be dispatched without a goal condition">
            no goal
          </span>
        ) : null}

        {/* Starting and stopping an agent is the primary action on a card, so
            it lives on the card rather than behind a menu. Pointer events are
            stopped so the button does not begin a drag. */}
        {card.status === 'running' ? (
          <button
            type="button"
            className="ml-auto rounded border border-warn/50 px-1.5 text-warn hover:bg-warn/10"
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
            className="ml-auto rounded border border-ok/50 px-1.5 text-ok hover:bg-ok/10"
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
    </li>
  );
}
