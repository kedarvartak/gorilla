import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCorners,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { useDroppable } from '@dnd-kit/core';

import {
  api,
  subscribe,
  type Board as BoardModel,
  type Card,
  type Column,
  type DispatchState,
  type SearchHit,
} from './api.js';
import { CardDetail } from './CardDetail.js';
import { Digest } from './Digest.js';
import { Invariants } from './Invariants.js';
import { Activity } from './Activity.js';
import { CardTile } from './CardTile.js';

/**
 * The board (doc 09, screen 1).
 *
 * Replaces the Phase 0 event page. The header is an instrument panel: running
 * sessions, unseen count, and - loudest of all - whether dispatch has halted
 * and which card is responsible, because a silently stopped queue looks
 * identical to an empty one.
 */

function unseenSince(card: Card): boolean {
  return card.lastSeenAt === null || card.updatedAt > card.lastSeenAt;
}

function ColumnView({
  column,
  cards,
  runnable,
  onOpen,
  onRun,
  onCancel,
}: {
  column: Column;
  cards: Card[];
  runnable: ReadonlySet<string>;
  onOpen: (card: Card) => void;
  onRun: (card: Card) => void;
  onCancel: (card: Card) => void;
}): ReactElement {
  const { setNodeRef, isOver } = useDroppable({ id: `column:${column.id}` });

  return (
    <section className="flex min-w-[260px] flex-1 flex-col">
      <header className="flex items-baseline justify-between border-b border-line px-1 pb-1.5">
        <h2 className="font-mono text-[11px] uppercase tracking-wider text-dim">
          {column.name}
          {column.isReady ? <span className="ml-1.5 text-ok">ready</span> : null}
          {column.isReviewGate ? <span className="ml-1.5 text-accent">gate</span> : null}
        </h2>
        <span className="font-mono text-[11px] text-dim">{cards.length}</span>
      </header>

      <SortableContext items={cards.map((card) => card.id)} strategy={verticalListSortingStrategy}>
        <ul
          ref={setNodeRef}
          className={`mt-2 flex min-h-24 flex-col gap-2 rounded p-1 ${isOver ? 'bg-panel-2' : ''}`}
        >
          {cards.map((card) => (
            <CardTile
              key={card.id}
              card={card}
              unseen={unseenSince(card)}
              runnable={runnable.has(card.id)}
              onOpen={onOpen}
              onRun={onRun}
              onCancel={onCancel}
            />
          ))}
        </ul>
      </SortableContext>
    </section>
  );
}

export function Board(): ReactElement {
  const [board, setBoard] = useState<BoardModel | null>(null);
  const [columns, setColumns] = useState<Column[]>([]);
  const [cards, setCards] = useState<Card[]>([]);
  const [dispatch, setDispatch] = useState<DispatchState | null>(null);
  const [live, setLive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Set when the served bundle is older than the server serving it (T1, T2). */
  const [staleBuild, setStaleBuild] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<readonly SearchHit[] | null>(null);
  const [title, setTitle] = useState('');
  const [newPriority, setNewPriority] = useState<Card['priority']>('normal');
  const [openCardId, setOpenCardId] = useState<string | null>(null);
  const [digestOpen, setDigestOpen] = useState(false);
  const [rulesOpen, setRulesOpen] = useState(false);
  const [activityOpen, setActivityOpen] = useState(false);
  const [runnable, setRunnable] = useState<ReadonlySet<string>>(new Set());

  const load = useCallback(async () => {
    try {
      const boards = await api.boards();
      const first = boards[0];
      if (first === undefined) {
        setBoard(null);
        return;
      }

      setBoard(first);
      const [nextColumns, nextCards, state, eligible] = await Promise.all([
        api.columns(first.id),
        api.cards(first.id),
        api.dispatchState(first.id),
        // Eligibility is the server's rule - ready column, idle, unblocked -
        // so the button cannot disagree with what dispatch would actually do.
        api.dispatchable(first.id),
      ]);

      setColumns(nextColumns);
      setCards(nextCards);
      setDispatch(state);
      setRunnable(new Set(eligible.map((card) => card.id)));
      setError(null);
    } catch (cause) {
      setError((cause as Error).message);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    // Asked once, at open. The answer cannot change while the page is loaded:
    // a rebuilt server is a restarted server, and this bundle would be gone.
    void fetch('/health')
      .then(async (response): Promise<unknown> => (response.ok ? await response.json() : null))
      .then((body: unknown) => {
        if (cancelled || typeof body !== 'object' || body === null) return;
        const build = (body as { build?: { note?: string | null } }).build;
        setStaleBuild(build?.note ?? null);
      })
      .catch(() => {
        /* the banner is a courtesy; failing to fetch it must not break the board */
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    void load();
    return subscribe(() => void load(), setLive);
  }, [load]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    // The board must be fully operable from the keyboard (doc 09), which is
    // the main reason for choosing dnd-kit.
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const byColumn = useMemo(() => {
    const map = new Map<string, Card[]>();
    for (const column of columns) map.set(column.id, []);
    for (const card of cards) map.get(card.columnId)?.push(card);
    for (const list of map.values()) list.sort((a, b) => a.position - b.position);
    return map;
  }, [columns, cards]);

  const unseen = cards.filter(unseenSince).length;

  async function onDragEnd(event: DragEndEvent): Promise<void> {
    const cardId = String(event.active.id);
    const over = event.over;
    if (over === null) return;

    const overId = String(over.id);
    const targetColumn = overId.startsWith('column:')
      ? overId.slice('column:'.length)
      : cards.find((card) => card.id === overId)?.columnId;

    if (targetColumn === undefined) return;

    const siblings = byColumn.get(targetColumn) ?? [];
    const index = overId.startsWith('column:')
      ? siblings.length
      : Math.max(
          0,
          siblings.findIndex((card) => card.id === overId),
        );

    try {
      await api.moveCard(cardId, targetColumn, index);
      setError(null);
    } catch (cause) {
      // A refused move is usually a dependency guard, and the reason is the
      // useful part - so it is shown rather than swallowed.
      setError((cause as Error).message);
    }
    await load();
  }

  async function run(card: Card): Promise<void> {
    if (board === null) return;
    try {
      setDispatch(await api.dispatchCard(board.id, card.id));
      setError(null);
    } catch (cause) {
      setError((cause as Error).message);
    }
    await load();
  }

  async function cancel(card: Card): Promise<void> {
    if (board === null) return;
    try {
      await api.cancelCard(board.id, card.id);
    } catch (cause) {
      setError((cause as Error).message);
    }
    await load();
  }

  async function addCard(): Promise<void> {
    if (board === null || title.trim() === '') return;
    try {
      await api.createCard(board.id, title.trim(), newPriority);
      setTitle('');
    } catch (cause) {
      setError((cause as Error).message);
    }
    await load();
  }

  if (board === null) {
    return (
      <main className="p-8 text-dim">
        <h1 className="mb-2 font-mono uppercase tracking-wider text-accent">Gorilla</h1>
        <p>
          No board yet. Create one with{' '}
          <code className="text-text">
            curl -X POST localhost:4300/api/boards -H &apos;content-type: application/json&apos; -d
            &apos;{'{'}&quot;cwd&quot;:&quot;/path/to/project&quot;{'}'}&apos;
          </code>
        </p>
      </main>
    );
  }

  return (
    <main className="relative flex h-full flex-col">
      <header className="flex flex-wrap items-baseline gap-x-6 gap-y-1 border-b border-line bg-panel px-4 py-2.5">
        <h1 className="font-mono text-[13px] uppercase tracking-wider text-accent">Gorilla</h1>
        <span className="font-mono text-[12px] text-dim">{board.name}</span>

        <span className="text-dim">
          stream <b className={live ? 'text-ok' : 'text-warn'}>{live ? 'live' : 'offline'}</b>
        </span>
        <span className="text-dim">
          running <b className="text-text">{dispatch?.running.length ?? 0}</b>
        </span>
        <span className="text-dim">
          unseen <b className={unseen > 0 ? 'text-accent' : 'text-text'}>{unseen}</b>
        </span>

        <span className="text-dim">
          finished{' '}
          <b className={(dispatch?.completed.length ?? 0) > 0 ? 'text-ok' : 'text-text'}>
            {dispatch?.completed.length ?? 0}
          </b>
        </span>

        <label className="text-dim">
          {/* The switch for "define tasks, run them, go to sleep". Under
              review the queue stops after every completion; unattended keeps
              going and collects them for the morning. */}
          policy{' '}
          <select
            className="rounded border border-line bg-panel-2 px-1 py-0.5 text-text"
            value={dispatch?.policy ?? 'review'}
            onChange={(changed) => {
              void api
                .setDispatch(board.id, { policy: changed.target.value })
                .then(setDispatch)
                .catch((cause: Error) => setError(cause.message));
            }}
          >
            <option value="review">review each</option>
            <option value="unattended">unattended</option>
          </select>
        </label>

        <label className="text-dim">
          agents{' '}
          <select
            className="rounded border border-line bg-panel-2 px-1 py-0.5 text-text"
            value={dispatch?.concurrency ?? 1}
            onChange={(changed) => {
              void api
                .setDispatch(board.id, { concurrency: Number(changed.target.value) })
                .then(setDispatch)
                .catch((cause: Error) => setError(cause.message));
            }}
          >
            {[1, 2, 3, 4, 6].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>

        <input
          className="w-52 rounded border border-line bg-panel-2 px-2 py-0.5 text-text placeholder:text-dim"
          placeholder="find a card, or a file it touched"
          aria-label="Search cards"
          value={query}
          onChange={(changed) => {
            const next = changed.target.value;
            setQuery(next);
            if (next.trim() === '') {
              setHits(null);
              return;
            }
            void api
              .search(board.id, next)
              .then(setHits)
              .catch((cause: Error) => setError(cause.message));
          }}
        />

        {/* Today's spend, always shown. The number is worth seeing on its own,
            and it is the only way to pick a budget that is neither pointless
            nor hit within the hour. The note carries its own caveat when some
            of today's runs recorded no usage. */}
        <span className="text-dim" title={dispatch?.spendNote ?? ''}>
          spent{' '}
          <span
            className={
              dispatch !== null &&
              dispatch.budget !== null &&
              dispatch.spend.tokens >= dispatch.budget
                ? 'text-warn'
                : 'text-text'
            }
          >
            {dispatch === null ? '—' : `${String(Math.round(dispatch.spend.tokens / 1000))}k`}
          </span>
          {dispatch === null || dispatch.budget === null
            ? ''
            : ` / ${String(Math.round(dispatch.budget / 1000))}k`}
          {/* A plus, because runs that recorded no usage make this a lower
              bound rather than a measurement. */}
          {dispatch !== null && dispatch.spend.unrecorded > 0 ? '+' : ''}
        </span>

        <label className="text-dim">
          dispatch{' '}
          <select
            className="rounded border border-line bg-panel-2 px-1 py-0.5 text-text"
            value={dispatch?.mode ?? 'manual'}
            onChange={(changed) => {
              void api
                .setDispatch(board.id, { mode: changed.target.value })
                .then(setDispatch)
                .catch((cause: Error) => setError(cause.message));
            }}
          >
            <option value="manual">manual</option>
            <option value="automatic">automatic</option>
          </select>
        </label>

        <button
          type="button"
          className="rounded border border-line bg-panel-2 px-2 py-1 text-text hover:border-dim"
          title="Every active card, ranked by what needs you first."
          onClick={() => setDigestOpen(true)}
        >
          digest
        </button>

        <button
          type="button"
          className="rounded border border-line bg-panel-2 px-2 py-1 text-text hover:border-dim"
          title="Rules handed to every card this board dispatches."
          onClick={() => setRulesOpen(true)}
        >
          rules
        </button>

        <button
          type="button"
          className={`rounded border px-2 py-1 hover:border-dim ${
            activityOpen ? 'border-info text-info' : 'border-line bg-panel-2 text-text'
          }`}
          title="What the agents are doing right now, as it happens."
          onClick={() => setActivityOpen(!activityOpen)}
        >
          activity
        </button>

        <div className="ml-auto flex items-center gap-2">
          {/* Set at creation, because priority is a statement about the batch
              and the moment you are describing the work is when you know it. */}
          <select
            className="rounded border border-line bg-panel-2 px-1 py-1 text-text"
            value={newPriority}
            aria-label="Priority for the new card"
            title="High and low reorder the dispatch queue within a column."
            onChange={(changed) => setNewPriority(changed.target.value as Card['priority'])}
          >
            <option value="high">high</option>
            <option value="normal">normal</option>
            <option value="low">low</option>
          </select>
          <input
            className="w-56 rounded border border-line bg-panel-2 px-2 py-1 text-text placeholder:text-dim"
            placeholder="New card title"
            value={title}
            onChange={(changed) => setTitle(changed.target.value)}
            onKeyDown={(key) => {
              if (key.key === 'Enter') void addCard();
            }}
          />
          <button
            type="button"
            className="rounded border border-line bg-panel-2 px-2 py-1 text-text hover:border-dim"
            onClick={() => void addCard()}
          >
            Add
          </button>
        </div>
      </header>

      {dispatch?.halted !== null && dispatch?.halted !== undefined ? (
        <div className="border-b border-warn/40 bg-warn/10 px-4 py-2 text-warn">
          {/* A stopped queue must not look like a finished one. */}
          <b>Dispatch halted</b> on “{dispatch.halted.cardTitle}” — {dispatch.halted.detail}{' '}
          <button
            type="button"
            className="ml-2 rounded border border-warn/50 px-2 py-0.5 hover:bg-warn/20"
            onClick={() => {
              void api.resumeDispatch(board.id).then(setDispatch);
            }}
          >
            Resume
          </button>
        </div>
      ) : null}

      {/* Shown above everything, because the symptom otherwise looks like a
          missing feature rather than an old bundle - which is what it looked
          like the two times this actually happened. */}
      {staleBuild === null ? null : (
        <div className="border-b border-line bg-panel-2 px-4 py-2 text-warn">{staleBuild}</div>
      )}

      {hits === null ? null : (
        <div className="border-b border-line bg-panel-2 px-4 py-2 font-mono text-[11px]">
          {hits.length === 0 ? (
            <span className="text-dim">Nothing matches “{query}”.</span>
          ) : (
            <ul className="flex flex-wrap gap-x-4 gap-y-1">
              {hits.map((hit) => (
                <li key={hit.cardId} className="text-dim">
                  <button
                    type="button"
                    className="text-text hover:underline"
                    onClick={() => setOpenCardId(hit.cardId)}
                  >
                    {hit.title}
                  </button>{' '}
                  {/* Says why, because a hit that cannot explain itself reads
                      as a broken search. */}
                  {hit.path === null ? hit.matched.join(', ') : hit.path}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {error !== null ? (
        <div className="border-b border-line bg-panel-2 px-4 py-2 text-warn">{error}</div>
      ) : null}

      <DndContext
        sensors={sensors}
        collisionDetection={closestCorners}
        onDragEnd={(event) => void onDragEnd(event)}
      >
        <div className="flex flex-1 gap-4 overflow-x-auto p-4">
          {columns.map((column) => (
            <ColumnView
              key={column.id}
              column={column}
              cards={byColumn.get(column.id) ?? []}
              runnable={runnable}
              onOpen={(card) => setOpenCardId(card.id)}
              onRun={(card) => void run(card)}
              onCancel={(card) => void cancel(card)}
            />
          ))}
        </div>
      </DndContext>

      {!digestOpen ? null : (
        <Digest
          boardId={board.id}
          onOpen={(cardId) => {
            setDigestOpen(false);
            setOpenCardId(cardId);
          }}
          onClose={() => setDigestOpen(false)}
        />
      )}

      {!rulesOpen ? null : <Invariants boardId={board.id} onClose={() => setRulesOpen(false)} />}

      {!activityOpen ? null : (
        <div className="h-56 shrink-0">
          <Activity
            live={live}
            titleFor={(cardId) =>
              cardId === null
                ? 'unbound session'
                : (cards.find((card) => card.id === cardId)?.title ?? 'unknown card')
            }
          />
        </div>
      )}

      {openCardId === null ? null : (
        <CardDetail
          cardId={openCardId}
          onClose={() => {
            setOpenCardId(null);
            void load();
          }}
        />
      )}
    </main>
  );
}
