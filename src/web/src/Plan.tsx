import { useEffect, useState, type ReactElement } from 'react';

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
    <div className="absolute inset-0 z-10 flex flex-col bg-bg/95">
      <header className="flex items-baseline gap-3 border-b border-line bg-panel px-4 py-2.5">
        <h2 className="font-mono text-[13px] uppercase tracking-wider text-accent">The order</h2>
        <span className="font-mono text-[11px] text-dim">{body?.note ?? ''}</span>
        <button
          type="button"
          className="ml-auto rounded border border-line px-2 py-0.5 text-dim hover:text-text"
          onClick={onClose}
        >
          close
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {body === null ? (
          <p className="text-dim">Reading the board.</p>
        ) : (
          <ol className="flex flex-col gap-1.5">
            {body.cards.map((card) => (
              <li
                key={card.cardId}
                className="flex items-baseline gap-3 rounded border border-line bg-panel px-3 py-2"
              >
                <span className="font-mono text-[11px] text-dim">{card.rank}</span>
                <button
                  type="button"
                  className="text-text hover:underline"
                  onClick={() => onOpen(card.cardId)}
                >
                  {card.title}
                </button>
                <span className="font-mono text-[11px] text-dim">{card.status}</span>
                {/* The reason, which is the whole point of this screen. A
                    blocked badge says a card cannot start; this says what it
                    is waiting for, by name. */}
                {card.waitingFor.length === 0 ? null : (
                  <span className="ml-auto font-mono text-[11px] text-warn">
                    waiting for {card.waitingFor.join(', ')}
                  </span>
                )}
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}
