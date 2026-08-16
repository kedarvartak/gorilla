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
  readonly onOpen: (card: Card) => void;
}

export function CardTile({ card, unseen, onOpen }: CardTileProps): ReactElement {
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
      </div>
    </li>
  );
}
