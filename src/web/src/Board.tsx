import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
} from 'react';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCorners,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  horizontalListSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useDroppable } from '@dnd-kit/core';

import {
  api,
  subscribe,
  type Board as BoardModel,
  type Card,
  type Column,
  type DispatchState,
  type ResyncReport,
  type SearchHit,
} from './api.js';
import { CardDetail } from './CardDetail.js';
import { Select, type SelectOption } from './Select.js';

/**
 * Priority, as a consequence rather than a word.
 *
 * "High" and "low" say where a card sits; what an operator wants to know is
 * what that does to the queue, which is the sentence the tooltip used to hold.
 */
const PRIORITIES: readonly SelectOption[] = [
  { value: 'high', label: 'High', hint: 'Dispatched before the rest of its column.' },
  { value: 'normal', label: 'Normal', hint: 'Dispatched in board order.' },
  { value: 'low', label: 'Low', hint: 'Dispatched after the rest of its column.' },
];
import { Plan } from './Plan.js';
import { Metrics } from './Metrics.js';
import { Compare } from './Compare.js';
import { Digest } from './Digest.js';
import { Invariants } from './Invariants.js';
import { Activity } from './Activity.js';
import { CardTile } from './CardTile.js';
import { Sidebar, type View } from './Sidebar.js';
import {
  CaretLeft,
  CaretRight,
  DotsSixVertical,
  ArrowsClockwise,
  MagnifyingGlass,
  Plus,
} from '@phosphor-icons/react';

import {
  DEFAULT_COLUMN_SHARE,
  loadCollapsed,
  loadColumnWidths,
  reorder,
  resizeColumnShares,
  saveCollapsed,
  saveColumnWidths,
  toggle,
  totalColumnShares,
} from './column-view-state.js';

/**
 * The board (doc 09, screen 1).
 *
 * Replaces the Phase 0 event page. The header is an instrument panel: running
 * sessions, unseen count, and - loudest of all - whether dispatch has halted
 * and which card is responsible, because a silently stopped queue looks
 * identical to an empty one.
 */

/**
 * Which droppables a drag is allowed to land on.
 *
 * Both kinds of drag share one context, and without this they compete: a
 * column dragged across the board is always nearer to some card than to the
 * far corner of the column under the pointer, so `closestCorners` hands back a
 * card and the column never moves. Restricting the candidates by what is being
 * dragged is what keeps the two independent.
 */
const boardCollisions: CollisionDetection = (args) => {
  const draggingColumn = String(args.active.id).startsWith(COLUMN_DRAG_PREFIX);

  return closestCorners({
    ...args,
    droppableContainers: args.droppableContainers.filter(
      (container) => String(container.id).startsWith(COLUMN_DRAG_PREFIX) === draggingColumn,
    ),
  });
};

/** Drops the undefined a lookup by id can produce, without widening the type. */
function isColumn(column: Column | undefined): column is Column {
  return column !== undefined;
}

function unseenSince(card: Card): boolean {
  return card.lastSeenAt === null || card.updatedAt > card.lastSeenAt;
}

/** Column ids are namespaced so one DndContext can carry both kinds of drag. */
const COLUMN_DRAG_PREFIX = 'col:';

function ColumnView({
  column,
  cards,
  runnable,
  whyNotRunnable,
  collapsed,
  share,
  totalShares,
  onToggle,
  onResize,
  onOpen,
  onRun,
  onCancel,
  onRename,
  onArchive,
}: {
  column: Column;
  cards: Card[];
  runnable: ReadonlySet<string>;
  whyNotRunnable: ReadonlyMap<string, string>;
  collapsed: boolean;
  /** This column's share of the board width, against `totalShares`. */
  share: number;
  totalShares: number;
  onToggle: (columnId: string) => void;
  onResize: (columnId: string, deltaPixels: number, finished: boolean) => void;
  onOpen: (card: Card) => void;
  onRun: (card: Card) => void;
  onCancel: (card: Card) => void;
  onRename: (card: Card, title: string) => void;
  onArchive: (card: Card) => void;
}): ReactElement {
  const { setNodeRef, isOver } = useDroppable({ id: `column:${column.id}` });

  // The header is the handle, not the whole column: a column that moved
  // whenever a card inside it was picked up would make the board unusable.
  const {
    attributes,
    listeners,
    setNodeRef: setColumnRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: `${COLUMN_DRAG_PREFIX}${column.id}` });

  const flags = column.isReady
    ? 'Cards here are eligible for dispatch'
    : column.isReviewGate
      ? 'Nothing merges from here while anything on it is unjudged'
      : undefined;

  const style = { transform: CSS.Transform.toString(transform), transition };

  const startResize = (event: ReactPointerEvent<HTMLDivElement>): void => {
    event.preventDefault();
    // Stopped, or the header's drag sensor claims the pointer and the column
    // is reordered instead of resized.
    event.stopPropagation();
    const handle = event.currentTarget;
    let lastX = event.clientX;
    handle.setPointerCapture(event.pointerId);

    const move = (moved: PointerEvent): void => {
      const delta = moved.clientX - lastX;
      lastX = moved.clientX;
      onResize(column.id, delta, false);
    };
    const stop = (): void => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', stop);
      handle.removeEventListener('pointercancel', stop);
      onResize(column.id, 0, true);
    };

    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', stop);
    handle.addEventListener('pointercancel', stop);
  };

  if (collapsed) {
    // A folded column keeps its count and its name. Dropped entirely it would
    // read as a column that had been deleted, and the operator who folded
    // "Done" three days ago would have no way back to it.
    return (
      <section
        ref={setColumnRef}
        style={style}
        className={`flex w-11 shrink-0 flex-col items-center gap-3 rounded-lg border bg-well py-3 transition-colors ${
          isDragging ? 'border-brand opacity-70' : 'border-line'
        }`}
        aria-label={`${column.name}, folded`}
      >
        <button
          type="button"
          className="rounded-md p-1 text-faint transition-colors hover:bg-surface hover:text-ink"
          onClick={() => onToggle(column.id)}
          title={`Unfold ${column.name}`}
          aria-label={`Unfold ${column.name}`}
        >
          <CaretRight size={14} aria-hidden />
        </button>

        <span className="text-[12.5px] font-medium tabular-nums text-dim">{cards.length}</span>

        <span
          className="eyebrow whitespace-nowrap [writing-mode:vertical-rl]"
          title={flags}
          {...attributes}
          {...listeners}
        >
          {column.name}
        </span>
      </section>
    );
  }

  return (
    <section
      ref={setColumnRef}
      style={{ ...style, flexGrow: share }}
      // A floor, not a fixed width. Five columns sharing a narrow window each
      // ended up about a hundred pixels wide, which turns every title into an
      // ellipsis; the row scrolls instead, and folding what is not in use is
      // the way to get the width back.
      // `relative` so the resize handle can sit on the right edge. The floor
      // stays: five columns sharing a narrow window each ended up about a
      // hundred pixels wide, which turns every title into an ellipsis, and the
      // row scrolls instead. `flexGrow` is the operator's share on top of it.
      //
      // The two interact, and the interaction is deliberate. Once every column
      // is at the floor the row overflows and scrolls, and there is no spare
      // width left for a share to divide - so dragging does nothing until the
      // row fits again, by widening the window or folding a column. Resizing
      // within a row that already overruns would mean growing the board rather
      // than redistributing it, which is not what the handle says it does.
      className={`relative flex min-h-0 w-[280px] min-w-[280px] basis-0 flex-col ${
        isDragging ? 'opacity-70' : ''
      }`}
      aria-label={column.name}
    >
      {/* Every unfolded column takes the same share of what is left. Fixed
          widths left a strip of dead board to the right of the last column; a
          wider last column made its cards a different size from every other
          card, which is worse - a board is read by scanning, and scanning
          wants one card shape. */}
      <header
        className={`group/header mb-2 flex items-center gap-2 rounded-md px-1 py-0.5 transition-colors ${
          isDragging ? 'bg-brand-tint' : 'hover:bg-well'
        }`}
      >
        {/* Grip on hover only. Five columns each showing a permanent handle is
            five pieces of furniture on a screen that is meant to be read. */}
        <span
          className="-ml-1 cursor-grab text-faint opacity-0 transition-opacity group-hover/header:opacity-100"
          title={`Drag to move ${column.name} in the pipeline`}
          {...attributes}
          {...listeners}
        >
          <DotsSixVertical size={14} aria-hidden />
        </span>

        {/* The flags used to print beside the name and stutter - "Ready ready",
            "Needs review gate". What they mean now lives in the tooltip and in
            a single dot, because the name already carries the word. */}
        <h2 className="eyebrow" title={flags}>
          {column.name}
        </h2>
        {column.isReady ? <span className="size-1 rounded-full bg-ok" aria-hidden /> : null}
        {column.isReviewGate ? (
          <span className="size-1 rounded-full bg-attention" aria-hidden />
        ) : null}
        <span className="text-[12.5px] tabular-nums text-faint">{cards.length}</span>

        <button
          type="button"
          className="ml-auto rounded-md p-1 text-faint opacity-0 transition-opacity hover:bg-surface hover:text-ink group-hover/header:opacity-100"
          onClick={() => onToggle(column.id)}
          title={`Fold ${column.name} away`}
          aria-label={`Fold ${column.name} away`}
        >
          <CaretLeft size={14} aria-hidden />
        </button>
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
            <li className="px-1 py-2 text-[12.5px] text-faint">
              {column.isTerminal ? 'Nothing finished yet.' : 'Nothing here.'}
            </li>
          ) : null}
          {cards.map((card) => (
            <CardTile
              key={card.id}
              card={card}
              unseen={unseenSince(card)}
              runnable={runnable.has(card.id)}
              whyNotRunnable={whyNotRunnable.get(card.id) ?? null}
              terminal={column.isTerminal}
              onOpen={onOpen}
              onRun={onRun}
              onCancel={onCancel}
              onRename={onRename}
              onArchive={onArchive}
            />
          ))}
        </ul>
      </SortableContext>

      {/* A width control of its own, separate from the header grip that
          reorders the pipeline. One pixel of rule with a wider invisible hit
          area: usable without drawing a second border down the board. */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={`Resize ${column.name}`}
        aria-valuemin={10}
        aria-valuemax={90}
        aria-valuenow={Math.round((share / totalShares) * 100)}
        tabIndex={0}
        className="group/resize absolute inset-y-0 -right-2 z-10 w-4 cursor-col-resize touch-none"
        title={`Drag to resize ${column.name}`}
        onPointerDown={startResize}
        onKeyDown={(event) => {
          const delta = event.key === 'ArrowLeft' ? -24 : event.key === 'ArrowRight' ? 24 : 0;
          if (delta === 0) return;
          event.preventDefault();
          onResize(column.id, delta, true);
        }}
      >
        <span className="mx-auto block h-full w-px bg-line transition-colors group-focus/resize:bg-brand group-hover/resize:bg-brand" />
      </div>
    </section>
  );
}

export function Board(): ReactElement {
  const [board, setBoard] = useState<BoardModel | null>(null);
  const [columns, setColumns] = useState<Column[]>([]);
  const [cards, setCards] = useState<Card[]>([]);
  const [dispatch, setDispatch] = useState<DispatchState | null>(null);
  const [live, setLive] = useState(false);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  /** Each column's share of the board width, as the operator has dragged it. */
  const [columnShares, setColumnShares] = useState<Record<string, number>>({});
  /** The last resync's report, kept until dismissed. */
  const [resyncReport, setResyncReport] = useState<ResyncReport | null>(null);
  const [resyncing, setResyncing] = useState(false);
  /** The row itself, so a drag in pixels can be turned into a share of it. */
  const boardRow = useRef<HTMLDivElement>(null);
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
  // Why the cards that are not runnable are not runnable. Held beside the set
  // rather than derived from it: the set says no, and this says which of the
  // four rules said it.
  const [whyNotRunnable, setWhyNotRunnable] = useState<ReadonlyMap<string, string>>(new Map());

  const load = useCallback(async () => {
    try {
      const boards = await api.boards();
      const first = boards[0];
      if (first === undefined) {
        setBoard(null);
        return;
      }

      setBoard(first);
      // Only on the first load. Re-reading storage on every refresh would
      // throw away a drag still in progress.
      setColumnShares((current) =>
        Object.keys(current).length > 0 ? current : loadColumnWidths(window.localStorage, first.id),
      );
      // Read once the board is known, because what is folded is per board.
      setCollapsed(loadCollapsed(window.localStorage, first.id));

      const [nextColumns, nextCards, state, eligible, standing] = await Promise.all([
        api.columns(first.id),
        api.cards(first.id),
        api.dispatchState(first.id),
        // Eligibility is the server's rule - ready column, idle, unblocked -
        // so the button cannot disagree with what dispatch would actually do.
        api.dispatchable(first.id),
        api.dispatchStanding(first.id),
      ]);

      setColumns(nextColumns);
      setCards(nextCards);
      setDispatch(state);
      setRunnable(new Set(eligible.map((card) => card.id)));
      // Only the cards that should carry a control and cannot use it. A card
      // in a terminal column is absent from this map and from the set, which
      // is how the tile knows to draw nothing at all.
      setWhyNotRunnable(
        new Map(
          standing
            .filter((entry) => entry.offer && entry.reason !== null)
            .map((entry) => [entry.id, entry.reason as string]),
        ),
      );
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
    const activeId = String(event.active.id);
    const over = event.over;
    if (over === null) return;

    const overId = String(over.id);

    // A column being dragged and a card being dragged arrive through the same
    // handler, and only the prefix separates them.
    if (activeId.startsWith(COLUMN_DRAG_PREFIX)) {
      // Anything that is not another column is not a place a column can go.
      // Without this a column dropped over a card would silently do nothing
      // or, worse, be read as a card id.
      if (!overId.startsWith(COLUMN_DRAG_PREFIX) || board === null) return;

      const ids = columns.map((column) => column.id);
      const next = reorder(
        ids,
        activeId.slice(COLUMN_DRAG_PREFIX.length),
        overId.slice(COLUMN_DRAG_PREFIX.length),
      );
      if (next === ids) return;

      // Shown moved before the server agrees. A pipeline that snaps back for
      // the length of a round trip reads as a drag that failed.
      setColumns(next.map((id) => columns.find((column) => column.id === id)).filter(isColumn));

      try {
        await api.reorderColumns(board.id, next);
        setError(null);
      } catch (cause) {
        setError((cause as Error).message);
      }
      await load();
      return;
    }

    const cardId = activeId;
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

  /**
   * Renamed in place, from the tile.
   *
   * Optimistic, then reloaded. A title that only changes after a round trip
   * reads as the edit having been dropped, and this one is typed rather than
   * clicked - the operator is already looking at the words.
   */
  async function rename(card: Card, title: string): Promise<void> {
    setCards((current) =>
      current.map((entry) => (entry.id === card.id ? { ...entry, title } : entry)),
    );
    try {
      await api.updateCard(card.id, { title });
    } catch (cause) {
      setError((cause as Error).message);
    }
    await load();
  }

  /**
   * Put away, not deleted.
   *
   * Archiving keeps the runs, the ledger and the operator's judgements, which
   * is the history this product exists to hold, and it can be undone. That is
   * why it is the action on the tile and deleting is not offered here at all.
   */
  async function archive(card: Card): Promise<void> {
    try {
      await api.archiveCard(card.id, true);
    } catch (cause) {
      setError((cause as Error).message);
    }
    await load();
  }

  /**
   * Catches the board up with work done outside it.
   *
   * The report is kept on screen rather than flashed, because this moves cards
   * and a change to the operator's queue that scrolls away unread is a change
   * made behind their back.
   */
  async function runResync(): Promise<void> {
    if (board === null || resyncing) return;
    setResyncing(true);
    try {
      setResyncReport(await api.resync(board.id));
      await load();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setResyncing(false);
    }
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
        {/* Wraps rather than overflows. At 1024 the row was 130px wider than
            the window, which put a horizontal scrollbar under every screen in
            the app including the ones that have no width problem of their
            own. */}
        <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line bg-surface px-4 py-2.5">
          {/* Search first and widest. On a board of sixty cards it is the
              fastest route to any of them, and it was previously one control
              among sixteen. */}
          <div className="relative w-72 min-w-[180px] flex-1">
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
          <dl className="flex items-baseline gap-4 text-[12.5px]">
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
            <Select
              variant="bare"
              label="Dispatch mode"
              value={dispatch?.mode ?? 'manual'}
              options={[
                { value: 'manual', label: 'Manual', hint: 'Holds the queue.' },
                {
                  value: 'automatic',
                  label: 'Automatic',
                  hint: 'Starts the next card itself.',
                },
              ]}
              onChange={(mode) => {
                void api
                  .setDispatch(board.id, { mode })
                  .then(setDispatch)
                  .catch((cause: Error) => setError(cause.message));
              }}
            />
            <span className="h-4 w-px bg-line" aria-hidden />
            <Select
              variant="bare"
              label="Review policy"
              value={dispatch?.policy ?? 'review'}
              options={[
                {
                  value: 'review',
                  label: 'Review each',
                  hint: 'Stops the queue after every card.',
                },
                {
                  value: 'unattended',
                  label: 'Unattended',
                  hint: 'Collects them for the morning.',
                },
              ]}
              onChange={(policy) => {
                void api
                  .setDispatch(board.id, { policy })
                  .then(setDispatch)
                  .catch((cause: Error) => setError(cause.message));
              }}
            />
            <span className="h-4 w-px bg-line" aria-hidden />
            <Select
              variant="bare"
              label="Agents at once"
              title="How many cards this board runs at the same time."
              value={String(dispatch?.concurrency ?? 1)}
              options={[1, 2, 3, 4, 6].map((n) => ({
                value: String(n),
                label: `${String(n)} agent${n === 1 ? '' : 's'}`,
                // Only where the number stops meaning what it looks like it
                // means. Labelling every row "runs N at a time" is noise.
                ...(n === 1
                  ? { hint: 'One card at a time, in queue order.' }
                  : { hint: `${String(n)} worktrees, ${String(n)} cards in flight.` }),
              }))}
              onChange={(concurrency) => {
                void api
                  .setDispatch(board.id, { concurrency: Number(concurrency) })
                  .then(setDispatch)
                  .catch((cause: Error) => setError(cause.message));
              }}
            />
          </div>

          {/* The composer. One cluster, so adding a card reads as one action
              rather than three adjacent controls. */}
          {/* Beside the composer rather than among the dispatch selects: those
              change what the board will do next, and this reconciles it with
              what has already happened somewhere else. */}
          <button
            type="button"
            disabled={resyncing}
            title="Check cards that look finished against what the repository actually shows, and move the confirmed ones to review"
            className="inline-flex items-center gap-1.5 rounded-md border border-line px-2.5 py-1.5 text-dim transition-colors hover:bg-well hover:text-ink disabled:cursor-not-allowed disabled:opacity-60"
            onClick={() => void runResync()}
          >
            <ArrowsClockwise size={14} className={resyncing ? 'animate-spin' : ''} aria-hidden />
            {resyncing ? 'Checking' : 'Resync'}
          </button>

          <div className="flex items-center rounded-md border border-line bg-surface">
            <Select
              variant="bare"
              className="rounded-r-none"
              label="Priority for the new card"
              value={newPriority}
              options={PRIORITIES}
              onChange={(priority) => setNewPriority(priority as Card['priority'])}
            />
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
          <div className="border-b border-line bg-well px-4 py-2 text-[12.5px]">
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

        {resyncReport === null ? null : (
          <div className="border-b border-line bg-well px-4 py-2.5 text-[12.5px]">
            <div className="flex items-start gap-3">
              <p className="min-w-0 flex-1 text-dim">
                {resyncReport.error ?? resyncReport.note}
                {/* What judged the board, and what it cost. An operator who is
                    being asked to accept a card moved into Done is entitled to
                    know which model said so. */}
                {resyncReport.error !== null || resyncReport.model === null ? null : (
                  <span className="text-faint">
                    {' '}
                    ({resyncReport.model}
                    {resyncReport.tokensSpent === null
                      ? ''
                      : `, ${resyncReport.tokensSpent.toLocaleString()} tokens`}
                    )
                  </span>
                )}
              </p>
              <button
                type="button"
                className="shrink-0 text-faint transition-colors hover:text-ink"
                onClick={() => setResyncReport(null)}
              >
                Dismiss
              </button>
            </div>

            {/* The reasoning, not just the count. A card was moved into a
                column on the strength of something the agent read, and an
                operator asked to accept that should be able to see what. */}
            {resyncReport.findings.length === 0 ? null : (
              <ul className="mt-1.5 flex flex-col gap-1.5">
                {resyncReport.findings.map((finding) => (
                  <li key={finding.cardId} className="leading-snug">
                    <span className="text-ink">{finding.title}</span>
                    {finding.movedTo === null ? (
                      <span className="text-faint"> · left where it was</span>
                    ) : (
                      <span className="text-brand"> · moved to {finding.movedTo}</span>
                    )}
                    <div className="text-faint">
                      {finding.evidence}
                      {finding.commits.slice(0, 3).map((hash) => (
                        <span key={hash}>
                          {' '}
                          <code className="font-mono">{hash}</code>
                        </span>
                      ))}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {/* The board stays under the card. The detail is a flap over the
            bottom of it, not a page instead of it, and the strip of columns
            left showing is what keeps the operator's place - which column
            this card is in, and what else is sitting in it. */}
        <DndContext
          sensors={sensors}
          collisionDetection={boardCollisions}
          onDragEnd={(event) => void onDragEnd(event)}
        >
          <SortableContext
            items={columns.map((column) => `${COLUMN_DRAG_PREFIX}${column.id}`)}
            strategy={horizontalListSortingStrategy}
          >
            <div ref={boardRow} className="flex min-h-0 flex-1 gap-3 overflow-x-auto px-3 py-4">
              {columns.map((column) => (
                <ColumnView
                  key={column.id}
                  column={column}
                  cards={byColumn.get(column.id) ?? []}
                  runnable={runnable}
                  whyNotRunnable={whyNotRunnable}
                  collapsed={collapsed.has(column.id)}
                  share={columnShares[column.id] ?? DEFAULT_COLUMN_SHARE}
                  totalShares={totalColumnShares(
                    columnShares,
                    columns.map((item) => item.id),
                  )}
                  onResize={(columnId, deltaPixels, finished) => {
                    setColumnShares((current) => {
                      const ids = columns.map((item) => item.id);
                      const available = boardRow.current?.clientWidth ?? 1;
                      const total = totalColumnShares(current, ids);
                      // Pixels are what the pointer reports and shares are what
                      // the layout takes, so the conversion has to happen here,
                      // against the row's actual width.
                      const deltaShares = (deltaPixels / available) * total;
                      const next = resizeColumnShares(current, ids, columnId, deltaShares);
                      // Written only when the drag ends. Saving per pointermove
                      // would write to storage sixty times a second.
                      if (finished && board !== null) {
                        saveColumnWidths(window.localStorage, board.id, next);
                      }
                      return next;
                    });
                  }}
                  onToggle={(columnId) => {
                    const next = toggle(collapsed, columnId);
                    setCollapsed(next);
                    if (board !== null) saveCollapsed(window.localStorage, board.id, next);
                  }}
                  onOpen={(card) => setOpenCardId(card.id)}
                  onRun={(card) => void run(card)}
                  onCancel={(card) => void cancel(card)}
                  onRename={(card, title) => void rename(card, title)}
                  onArchive={(card) => void archive(card)}
                />
              ))}
            </div>
          </SortableContext>
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
