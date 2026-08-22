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
import { Plan } from './Plan.js';
import { Metrics } from './Metrics.js';
import { Compare } from './Compare.js';
import { Digest } from './Digest.js';
import { Invariants } from './Invariants.js';
import { Activity } from './Activity.js';
import { CardTile } from './CardTile.js';
import { Sidebar, type View } from './Sidebar.js';
import { MagnifyingGlass, Plus } from '@phosphor-icons/react';

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

  // Every column the same share of the width. Fixed widths left a strip of
  // dead board to the right of the last column; a wider last column made its
  // cards a different size from every other card, which is worse - a board is
  // read by scanning, and scanning wants one card shape.
  const width = 'min-w-0 flex-1 basis-0';

  return (
    <section className={`flex min-h-0 flex-col ${width}`} aria-label={column.name}>
      <header className="flex items-baseline gap-2 px-1 pb-2">
        {/* The flags used to print beside the name and stutter - "Ready ready",
            "Needs review gate". What they mean now lives in the tooltip and in
            a single dot, because the name already carries the word. */}
        <h2
          className="eyebrow"
          title={
            column.isReady
              ? 'Cards here are eligible for dispatch'
              : column.isReviewGate
                ? 'Nothing merges from here while anything on it is unjudged'
                : undefined
          }
        >
          {column.name}
        </h2>
        {column.isReady ? <span className="size-1 rounded-full bg-ok" aria-hidden /> : null}
        {column.isReviewGate ? (
          <span className="size-1 rounded-full bg-attention" aria-hidden />
        ) : null}
        <span className="text-[11px] tabular-nums text-faint">{cards.length}</span>
      </header>

      <SortableContext items={cards.map((card) => card.id)} strategy={verticalListSortingStrategy}>
        <ul
          ref={setNodeRef}
          // A lane with a body. Left as bare background, an empty column is
          // indistinguishable from the void beside the board, and the whole
          // middle of a working board reads as nothing rather than as three
          // columns with nothing in them.
          className={`flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto rounded-lg border p-2 transition-colors ${
            isOver ? 'border-brand bg-brand-tint' : 'border-transparent bg-well'
          }`}
        >
          {cards.length === 0 ? (
            /* An empty column is a legitimate state, not a setup step nobody
               completed, so it says what would put a card here. */
            <li className="px-1 py-2 text-[11px] text-faint">
              {column.isTerminal ? 'Nothing finished yet.' : 'Nothing here.'}
            </li>
          ) : null}
          {cards.map((card) => (
            <CardTile
              key={card.id}
              card={card}
              unseen={unseenSince(card)}
              runnable={runnable.has(card.id)}
              terminal={column.isTerminal}
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
  // One view at a time, named rather than four booleans that could all be
  // true. The rail reads the same value it sets.
  const [view, setView] = useState<View>('board');
  const [comparing, setComparing] = useState<readonly string[] | null>(null);
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
    void api.health<{ build?: { note?: string | null } }>().then((body) => {
      if (cancelled) return;
      // The banner is a courtesy. A health endpoint that will not answer must
      // not be able to take the board down with it.
      setStaleBuild(body?.build?.note ?? null);
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
      const created = await api.createCard(board.id, title.trim(), newPriority);
      setTitle('');
      // Shown where errors are shown, but the card exists: this is a warning
      // about the board's contents, not a failure to add to it (T53).
      setError(created.duplicateNote ?? null);
    } catch (cause) {
      setError((cause as Error).message);
    }
    await load();
  }

  if (board === null) {
    return (
      <main className="p-8 text-dim">
        <h1 className="mb-2 font-mono uppercase tracking-wider text-brand">Gorilla</h1>
        <p>
          No board yet. Create one with{' '}
          <code className="text-ink">
            curl -X POST localhost:4300/api/boards -H &apos;content-type: application/json&apos; -d
            &apos;{'{'}&quot;cwd&quot;:&quot;/path/to/project&quot;{'}'}&apos;
          </code>
        </p>
      </main>
    );
  }

  return (
    <div className="flex h-full">
      <Sidebar
        boardName={board.name}
        view={view}
        live={live}
        spent={dispatch?.spendNote ?? null}
        activityOpen={activityOpen}
        onSelect={setView}
        onToggleActivity={() => setActivityOpen((open) => !open)}
      />

      <main className="relative flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-3 border-b border-line bg-surface px-4 py-2.5">
          {/* Search first and widest. On a board of sixty cards it is the
              fastest route to any of them, and it was previously one control
              among sixteen. */}
          <div className="relative w-72">
            <MagnifyingGlass
              size={15}
              aria-hidden
              className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-faint"
            />
            <input
              className="w-full rounded-md border border-line bg-surface py-1.5 pr-2.5 pl-8 text-ink transition-colors placeholder:text-faint focus:border-edge"
              placeholder="Find a card, or a file it touched"
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
          </div>

          {/* Three numbers, and only three. What is happening, what wants you,
              what finished - in that order, because that is the order an
              operator asks. */}
          <dl className="flex items-baseline gap-4 text-[11px]">
            <div className="flex items-baseline gap-1.5">
              <dt className="text-faint">Running</dt>
              <dd className="tabular-nums text-ink">{dispatch?.running.length ?? 0}</dd>
            </div>
            <div className="flex items-baseline gap-1.5">
              <dt className="text-faint">Unseen</dt>
              <dd className={`tabular-nums ${unseen > 0 ? 'text-attention' : 'text-ink'}`}>
                {unseen}
              </dd>
            </div>
            <div className="flex items-baseline gap-1.5">
              <dt className="text-faint">Finished</dt>
              <dd className="tabular-nums text-ink">{dispatch?.completed.length ?? 0}</dd>
            </div>
          </dl>

          {/* How the queue behaves, grouped as one control rather than three
              labelled fields spread across the bar. */}
          <div className="ml-auto flex items-center gap-1 rounded-md border border-line bg-surface p-0.5">
            <select
              className="rounded-sm bg-transparent px-1.5 py-1 text-dim focus:text-ink"
              aria-label="Dispatch mode"
              title="Manual holds the queue. Automatic starts the next card itself."
              value={dispatch?.mode ?? 'manual'}
              onChange={(changed) => {
                void api
                  .setDispatch(board.id, { mode: changed.target.value })
                  .then(setDispatch)
                  .catch((cause: Error) => setError(cause.message));
              }}
            >
              <option value="manual">Manual</option>
              <option value="automatic">Automatic</option>
            </select>
            <span className="h-4 w-px bg-line" aria-hidden />
            <select
              className="rounded-sm bg-transparent px-1.5 py-1 text-dim focus:text-ink"
              aria-label="Review policy"
              title="Review stops the queue after every card. Unattended collects them for the morning."
              value={dispatch?.policy ?? 'review'}
              onChange={(changed) => {
                void api
                  .setDispatch(board.id, { policy: changed.target.value })
                  .then(setDispatch)
                  .catch((cause: Error) => setError(cause.message));
              }}
            >
              <option value="review">Review each</option>
              <option value="unattended">Unattended</option>
            </select>
            <span className="h-4 w-px bg-line" aria-hidden />
            <select
              className="rounded-sm bg-transparent px-1.5 py-1 text-dim focus:text-ink"
              aria-label="Agents at once"
              title="How many cards this board runs at the same time."
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
                  {n} agent{n === 1 ? '' : 's'}
                </option>
              ))}
            </select>
          </div>

          {/* The composer. One cluster, so adding a card reads as one action
              rather than three adjacent controls. */}
          <div className="flex items-center rounded-md border border-line bg-surface">
            <select
              className="rounded-l-md bg-transparent py-1.5 pl-2 pr-1 text-dim focus:text-ink"
              value={newPriority}
              aria-label="Priority for the new card"
              title="High and low reorder the dispatch queue within a column."
              onChange={(changed) => setNewPriority(changed.target.value as Card['priority'])}
            >
              <option value="high">High</option>
              <option value="normal">Normal</option>
              <option value="low">Low</option>
            </select>
            <input
              className="w-52 bg-transparent px-2 py-1.5 text-ink placeholder:text-faint"
              placeholder="New card"
              aria-label="New card title"
              value={title}
              onChange={(changed) => setTitle(changed.target.value)}
              onKeyDown={(key) => {
                if (key.key === 'Enter') void addCard();
              }}
            />
            <button
              type="button"
              className="inline-flex items-center gap-1 rounded-r-md border-l border-line px-2.5 py-1.5 text-dim transition-colors hover:bg-well hover:text-ink"
              onClick={() => void addCard()}
            >
              <Plus size={14} aria-hidden />
              Add
            </button>
          </div>
        </header>

        {dispatch?.halted !== null && dispatch?.halted !== undefined ? (
          <div className="border-b border-danger/40 bg-danger/10 px-4 py-2 text-danger">
            {/* A stopped queue must not look like a finished one. */}
            <b>Dispatch halted</b> on “{dispatch.halted.cardTitle}” — {dispatch.halted.detail}{' '}
            <button
              type="button"
              className="ml-2 rounded border border-danger/50 px-2 py-0.5 hover:bg-danger/20"
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
          <div className="border-b border-line bg-well px-4 py-2 text-danger">{staleBuild}</div>
        )}

        {/* A hold is not an error and not a halt: the clock will clear it. Said
          in its own line so it does not read as something to fix. */}
        {dispatch === null || dispatch.holdingFor === null ? null : (
          <div className="border-b border-line bg-well px-4 py-2 text-dim">
            {dispatch.holdingFor}
          </div>
        )}

        {hits === null ? null : (
          <div className="border-b border-line bg-well px-4 py-2 text-[11px]">
            {hits.length === 0 ? (
              <span className="text-dim">Nothing matches “{query}”.</span>
            ) : (
              <ul className="flex flex-wrap gap-x-4 gap-y-1">
                {hits.map((hit) => (
                  <li key={hit.cardId} className="text-dim">
                    <button
                      type="button"
                      className="text-ink hover:underline"
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
          <div className="border-b border-line bg-well px-4 py-2 text-danger">{error}</div>
        ) : null}

        <DndContext
          sensors={sensors}
          collisionDetection={closestCorners}
          onDragEnd={(event) => void onDragEnd(event)}
        >
          <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto px-3 py-4">
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

        {view !== 'digest' ? null : (
          <Digest
            boardId={board.id}
            onOpen={(cardId) => {
              setView('board');
              setOpenCardId(cardId);
            }}
            onClose={() => setView('board')}
          />
        )}

        {comparing === null ? null : (
          <Compare boardId={board.id} cardIds={comparing} onClose={() => setComparing(null)} />
        )}

        {view !== 'numbers' ? null : (
          <Metrics boardId={board.id} onClose={() => setView('board')} />
        )}

        {view !== 'order' ? null : (
          <Plan
            boardId={board.id}
            onOpen={(cardId) => {
              setView('board');
              setOpenCardId(cardId);
            }}
            onClose={() => setView('board')}
          />
        )}

        {view !== 'rules' ? null : (
          <Invariants boardId={board.id} onClose={() => setView('board')} />
        )}

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
            onCompare={(otherCardId) => setComparing([openCardId, otherCardId])}
            onClose={() => {
              setOpenCardId(null);
              void load();
            }}
          />
        )}
      </main>
    </div>
  );
}
