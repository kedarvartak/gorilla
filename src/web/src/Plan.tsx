import { useEffect, useState, type ReactElement } from 'react';
import { X } from '@phosphor-icons/react';

import { Panel } from './Panel.js';

import { api } from './api.js';

/**
 * The order the board will work in, and why anything is waiting (T64).
 *
 * The board shows a rank on each card and a badge when one is blocked. What it
 * could not show is the reason, because the reason is another card and a tile
 * has no room for it. Read here as a list rather than drawn as a graph: forty
 * cards of edges is a picture nobody can read, and the operator's question is
 * an ordering question anyway.
 */

interface PlannedCard {
  readonly cardId: string;
  readonly title: string;
  readonly rank: number;
  readonly status: string;
  readonly blocked: boolean;
  readonly waitingFor: readonly string[];
}

interface PlanBody {
  readonly cards: readonly PlannedCard[];
  readonly free: number;
  readonly note: string;
}

export function Plan({
  boardId,
  onOpen,
  onClose,
}: {
  boardId: string;
  onOpen: (cardId: string) => void;
  onClose: () => void;
}): ReactElement {
  const [body, setBody] = useState<PlanBody | null>(null);

  useEffect(() => {
    let cancelled = false;

    void api.plan<PlanBody>(boardId).then((loaded) => {
      if (!cancelled) setBody(loaded);
    });

    return () => {
      cancelled = true;
    };
  }, [boardId]);

  return (
    <Panel title="The order the board will work in" onClose={onClose}>
      <header className="flex items-baseline gap-3 border-b border-line bg-surface px-4 py-2.5">
        <h2 className="text-[13px] font-semibold tracking-tight text-ink">The order</h2>
        <span className="text-[11px] text-dim">{body?.note ?? ''}</span>
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
        <div className="mx-auto w-full max-w-4xl">
          {body === null ? (
            <p className="text-dim">Reading the board.</p>
          ) : (
            <ol className="flex flex-col gap-1.5">
              {body.cards.map((card) => (
                <li
                  key={card.cardId}
                  className="flex items-baseline gap-3 rounded border border-line bg-surface px-3 py-2"
                >
                  <span className="text-[11px] text-dim">{card.rank}</span>
                  <button
                    type="button"
                    className="text-ink hover:underline"
                    onClick={() => onOpen(card.cardId)}
                  >
                    {card.title}
                  </button>
                  <span className="text-[11px] text-dim">{card.status}</span>
                  {/* The reason, which is the whole point of this screen. A
                    blocked badge says a card cannot start; this says what it
                    is waiting for, by name. */}
                  {card.waitingFor.length === 0 ? null : (
                    <span className="ml-auto text-[11px] text-danger">
                      waiting for {card.waitingFor.join(', ')}
                    </span>
                  )}
                </li>
              ))}
            </ol>
          )}
        </div>
      </div>
    </Panel>
  );
}
