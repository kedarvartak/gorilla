import {
  Children,
  Fragment,
  isValidElement,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';

import { Select, type SelectOption } from './Select.js';
import { Timeline } from './Timeline.js';

import {
  Archive,
  CheckCircle,
  Copy,
  DownloadSimple,
  MagnifyingGlass,
  Question,
  Warning,
  X,
} from '@phosphor-icons/react';

import {
  api,
  type Card,
  type GuardrailDetail,
  type GuardrailProposal,
  type Narration as NarrationModel,
  type NarrationEntry,
  type MergeReport,
} from './api.js';

/**
 * Card detail (doc 09, screen 2).
 *
 * One focused pane at a time: specification, the brief, or review history.
 * The brief opens first because it answers "what happened while I was away";
 * the other views stay one click away instead of competing for attention.
 *
 * The specification rail must show each guardrail's enforcement kind. An
 * interface that presents an advisory rule as though it were enforced sends
 * the operator into an unattended run believing in a protection that does not
 * exist (R10), so the kind is rendered beside every rule rather than being
 * available on hover.
 */

/**
 * The per-card model controls.
 *
 * `agentModel` and `agentEffort` reach `claude --model` and `--effort` for the
 * run; `synthesisModel` is used only for windows that escalate, which today
 * means compaction. They are separate on purpose: the model that does the work
 * and the model that describes the work are different decisions with different
 * costs, and a card doing mechanical work with subtle reasoning behind it wants
 * a cheap agent and an expensive synthesiser.
 *
 * Null everywhere means the board default, which is what most cards should say.
 */
const CLAUDE_MODELS = ['haiku', 'sonnet', 'opus', 'fable'] as const;
/* The ids the installed Codex CLI actually offers. The list before this one
   was `gpt-5.3-codex`, `gpt-5.2-codex` and `o3`, none of which it recognises -
   so every one of them was a card that would fail at dispatch. */
const CODEX_MODELS = [
  'gpt-5.4-mini',
  'gpt-5.4',
  'gpt-5.5',
  'gpt-5.6-luna',
  'gpt-5.6-sol',
  'gpt-5.6-terra',
] as const;
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

interface LedgerEntry {
  readonly kind: string;
  readonly statement: string;
  readonly detail?: string;
  readonly sourceEventIds: readonly number[];
}

/**
 * The review tab carries the card's total, because the operator's question is
 * what the card cost, not what its third run cost.
 *
 * On the tab rather than over the pane. A pane that is only shown when it is
 * chosen cannot be where a total lives - the operator would have to open the
 * runs to find out whether the runs were worth opening.
 *
 * Only the dollar figures the CLI reported are added up. Mixing in the runs
 * whose totals were added up from messages would produce one number the
 * operator cannot tell is part estimate, so the count of unpriced runs is
 * stated separately instead.
 */
function runsSummary(runs: readonly RunDetail[]): string {
  const count = `${String(runs.length)} run${runs.length === 1 ? '' : 's'}`;

  const priced = runs.filter((run) => run.cost !== null && run.cost.costUsd !== null);
  const spent = priced.reduce((total, run) => total + (run.cost?.costUsd ?? 0), 0);
  const unpriced = runs.length - priced.length;

  if (priced.length === 0) return count;

  const note = unpriced === 0 ? '' : `, ${String(unpriced)} unpriced`;
  return `${count} · $${spent.toFixed(2)}${note}`;
}

interface RunDetail {
  readonly runId: string;
  readonly sessionId: string;
  readonly startedAt: number;
  readonly endedAt: number | null;
  /**
   * Why it ended. `interrupted` means the board deduced the end rather than
   * being told - it must never be presented as if the session reported it.
   */
  readonly endReason: string | null;
  readonly goalOutcome: string | null;
  readonly mode: 'launched' | 'attached';
  readonly events: number;
  readonly ledger: {
    readonly entries: readonly LedgerEntry[];
    readonly changed: readonly string[];
  };
  /**
   * Null when nothing is known, which is not the same as nothing was spent.
   * Runs from before the board recorded cost read as null forever.
   */
  readonly cost: RunCost | null;
}

interface RunCost {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheCreationTokens: number;
  /** Present only when the CLI reported its own total. */
  readonly costUsd: number | null;
  readonly turns: number | null;
  readonly source: 'result' | 'messages';
  readonly summary: string;
}

interface VerifyReport {
  readonly status: 'passed' | 'failed' | 'errored' | 'skipped';
  readonly command: string;
  readonly exitCode: number | null;
  readonly output: string;
  readonly durationMs: number;
}

interface BriefSection {
  readonly title: string;
  readonly lines: readonly string[];
  readonly empty: boolean;
}

interface Surprise {
  readonly id: string;
  readonly kind: 'superseded' | 'assumption' | 'unmentioned-change';
  readonly headline: string;
  readonly detail?: string;
  readonly why: string;
  readonly target: { type: 'entry'; entryId: string } | { type: 'path'; path: string };
}

/**
 * One subagent's work (doc 05).
 *
 * A subagent's context is discarded when it stops and the parent keeps only the
 * message it returned, so files edited inside one otherwise arrive in the blast
 * radius attributed to a session that did not edit them.
 */
interface Subagent {
  readonly agentId: string;
  readonly agentType: string | null;
  readonly toolCalls: number;
  readonly files: readonly string[];
  readonly result: string | null;
  readonly durationMs: number | null;
  readonly finished: boolean;
}

interface Brief {
  readonly headline: string;
  readonly sections: readonly BriefSection[];
  readonly unseenCount: number;
  readonly nothingNew: boolean;
  readonly extraction: {
    readonly configured: boolean;
    readonly tokensSpent: number;
    readonly note: string | null;
  };
  /** What the operator would regret not reading, still unjudged. */
  readonly surprises: readonly Surprise[];
}

interface Workspace {
  readonly branch: string;
  readonly worktree: string;
  readonly git: { branch: string; dirty: number; ahead: number } | null;
}

export interface GuardrailSet {
  readonly scope: readonly string[];
  readonly prohibit: readonly string[];
  readonly allowTools: readonly string[];
  readonly verify: string | null;
  readonly maxTurns: number | null;
}

/**
 * What a card's guardrails are when the response does not carry them.
 *
 * The pane reads an API response, which is foreign data like any other: an older
 * server, or a field renamed, must degrade what the rail can edit rather than
 * throw while rendering. Requiring the field crashed every test that did not
 * happen to include it, which is the same fragility one layer up.
 */
const NO_GUARDRAILS: GuardrailSet = {
  scope: [],
  prohibit: [],
  allowTools: [],
  verify: null,
  maxTurns: null,
};

interface StaleFinding {
  readonly signal: string;
  readonly detail: string;
  readonly evidence: readonly string[];
}

interface Staleness {
  readonly suspect: boolean;
  readonly findings: readonly StaleFinding[];
  readonly advice: string | null;
}

interface Detail {
  readonly card: Card;
  /** Whether this card still describes work that needs doing. */
  readonly staleness?: Staleness | null;
  /** Parsed by the server, so the interface never re-implements the shape. */
  readonly guardrails?: GuardrailSet;
  readonly verify: VerifyReport | null;
  readonly verifyNote: string | null;
  readonly guardrailDetail: readonly GuardrailDetail[];
  readonly blockers: readonly { cardId: string; title: string; status: string }[];
  /**
   * What this card's work touched, grouped (T13). Empty before it has run.
   *
   * Optional because a server older than this build does not send it, and a
   * board that renders nothing is better than one that throws. T1's handshake
   * is the real fix; until it lands, every field added here has to survive
   * being absent.
   */
  readonly subsystems?: readonly { subsystem: string; paths: number }[];
  /** Earlier cards that touched the same files, most overlap first. */
  readonly relatedCards?: readonly { cardId: string; title: string; shared: readonly string[] }[];
  /** Paths the run said it changed that git did not see. A question, not a verdict. */
  readonly claimedNotInGit?: readonly string[];
  /** Whether this would merge cleanly, asked without attempting it (T39). */
  readonly mergeForecast?: {
    readonly clean: boolean;
    readonly conflicts: readonly string[];
    /** False when the question could not be asked. Never presented as clean. */
    readonly readable: boolean;
    readonly note: string;
  };
  /** What the operator is about to accept, assembled from what the card holds (T37). */
  readonly readiness?: {
    readonly checks: readonly {
      name: string;
      state: 'settled' | 'needs-you' | 'unknown';
      detail: string;
    }[];
    /** True when nothing on the list needs them. Not a recommendation to merge. */
    readonly settled: boolean;
  };
  /** Project rules this card's scope runs into (T16). Worth a look, not an error. */
  readonly contradictions?: readonly {
    invariant: string;
    conflict: string;
    where: 'scope' | 'body';
  }[];
  /** What cards like this one have touched before (T18). A guess, said as one. */
  readonly blastRadius?: {
    readonly paths: readonly { path: string; cards: number }[];
    readonly subsystems: readonly string[];
    readonly from: readonly { cardId: string; title: string }[];
  };
  /** What the branch changed, from git (T30). */
  readonly diff?: {
    readonly files: readonly {
      path: string;
      insertions: number;
      deletions: number;
      binary: boolean;
    }[];
    readonly insertions: number;
    readonly deletions: number;
    /** False when the branch could not be read - usually because it was merged away. */
    readonly readable: boolean;
  };
  readonly runs: readonly RunDetail[];
  readonly realityNotes: readonly string[];
  /** The isolated branch this card's work sits on, or null if it never ran. */
  readonly workspace: Workspace | null;
  /** The branch a merge would land on, named before it is offered. */
  readonly mergeTarget: string | null;
  readonly verifyCommand: string | null;
}

/** "4m 12s", so a run's cost in time is readable without arithmetic. */
function duration(fromMs: number, toMs: number): string {
  const seconds = Math.max(0, Math.round((toMs - fromMs) / 1000));
  if (seconds < 60) return `${String(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${String(minutes)}m ${String(seconds % 60)}s`;
  return `${String(Math.floor(minutes / 60))}h ${String(minutes % 60)}m`;
}

/**
 * What a run's end means, in the operator's words.
 *
 * The `interrupted` case is the one that matters: the board never saw the
 * session end, it worked out afterwards that it must have. Saying "finished"
 * there would be the board inventing a fact.
 */
function endedNote(run: RunDetail): { text: string; tone: string } {
  if (run.endedAt === null) return { text: 'running now', tone: 'text-ok' };

  const took = duration(run.startedAt, run.endedAt);

  if (run.endReason === 'interrupted') {
    return {
      text: `cut off after ${took} - the board never saw it end, so this time is an estimate`,
      tone: 'text-danger',
    };
  }

  return { text: `ran ${took}, ended: ${run.endReason ?? 'no reason given'}`, tone: 'text-dim' };
}

const KIND_COLOUR: Record<string, string> = {
  change: 'text-info',
  risk: 'text-danger',
  question: 'text-brand',
  verdict: 'text-ok',
};

/**
 * A comma-separated list, as the operator typed it.
 *
 * Empty entries are dropped rather than stored: a trailing comma is a typing
 * artefact, and an empty prohibition would render as a rule that forbids nothing.
 */
function asList(raw: string): string[] {
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
}

/**
 * As tall as a field is allowed to grow before it starts scrolling after all.
 *
 * About twenty lines. Measured against the board rather than guessed: the
 * longest goal condition on it wants 414 pixels, so a cap under that would
 * leave the one field most worth reading in full still scrolling. Past this a
 * value is a scope list of thirty paths, and a box that kept growing would
 * push the rest of the card's settings off the screen to show it.
 */
const MAX_FIELD_PX = 440;

/**
 * One editable field, saved on blur or Enter rather than per keystroke.
 *
 * Per-keystroke saving would write a partial goal condition to the card, and a
 * card is dispatchable the moment it has one - so a half-typed condition is a
 * card that can be picked up saying something the operator did not mean.
 */
function TextField({
  label,
  value,
  placeholder,
  invalid = false,
  invalidNote,
  onSave,
}: {
  label: string;
  value: string;
  placeholder: string;
  invalid?: boolean;
  invalidNote?: string;
  onSave: (value: string) => void;
}): ReactElement {
  const [draft, setDraft] = useState(value);
  const [editing, setEditing] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);

  // Reset when the stored value changes underneath - another tab, or a run.
  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);

  /**
   * The field is as tall as what is in it.
   *
   * It was one row. A goal condition is a sentence, a scope is a list of paths
   * and a verify is a command with four clauses joined by `&&`, so every one of
   * these was a one-line porthole onto a paragraph: to read the value you
   * scrolled it, and scrolling it took the beginning of the value out of view.
   * The operator could not see what the card would actually run without
   * dragging the corner of each box in turn.
   *
   * Reset to `auto` before reading `scrollHeight`, or the measurement is taken
   * against the height already set and the box can only ever grow.
   */
  useLayoutEffect(() => {
    const node = box.current;
    if (node === null) return;

    const fit = (): void => {
      node.style.height = 'auto';
      node.style.height = `${String(Math.min(node.scrollHeight, MAX_FIELD_PX))}px`;
    };

    fit();

    /*
     * And again whenever the box changes width.
     *
     * The height is a function of the width, and the width moves: the section
     * these sit in takes two columns when the pane is wide enough, so the same
     * goal condition is fourteen lines in one column and six in two. Fitted
     * only on edit, the field kept the height it was first measured at and the
     * section stayed as tall as it had been when it was half as wide - which
     * is the whole of what widening it was supposed to fix.
     */
    if (typeof ResizeObserver === 'undefined') return;
    let width = node.clientWidth;
    const observer = new ResizeObserver(() => {
      // Width only. Observing height would see the height this sets and fit
      // against its own output.
      if (node.clientWidth === width) return;
      width = node.clientWidth;
      fit();
    });
    observer.observe(node);
    return () => {
      observer.disconnect();
    };
  }, [draft]);

  const commit = (): void => {
    setEditing(false);
    if (draft.trim() !== value) onSave(draft.trim());
  };

  return (
    <>
      <textarea
        ref={box}
        className={`field w-full resize-none overflow-y-auto leading-snug placeholder:text-dim ${
          invalid ? 'border-danger/60' : ''
        }`}
        rows={1}
        value={draft}
        aria-label={label}
        placeholder={placeholder}
        onFocus={() => setEditing(true)}
        onChange={(changed) => setDraft(changed.target.value)}
        onBlur={commit}
        onKeyDown={(key) => {
          // Enter saves; Shift+Enter is a newline, since a goal condition is
          // often a sentence long enough to want one.
          if (key.key === 'Enter' && !key.shiftKey) {
            key.preventDefault();
            (key.target as HTMLTextAreaElement).blur();
          }
          if (key.key === 'Escape') {
            setDraft(value);
            setEditing(false);
            (key.target as HTMLTextAreaElement).blur();
          }
        }}
      />
      {invalid && invalidNote !== undefined && !editing ? (
        <div className="t-fine text-danger">{invalidNote}</div>
      ) : null}
    </>
  );
}

/** One labelled dropdown over a nullable card field, saving on change. */
function FieldSelect({
  label,
  value,
  options,
  title,
  hints,
  neutralLabel = 'board default',
  onPick,
}: {
  label: string;
  value: string | null;
  options: readonly string[];
  title: string;
  /** What choosing an option does, for the fields where that is not obvious.
   *  Model and effort lists are model names and need no gloss. */
  hints?: Readonly<Record<string, string>>;
  /** What "unset" means for this field; not every field defers to the board. */
  neutralLabel?: string;
  onPick: (value: string | null) => void;
}): ReactElement {
  /* A value set by /gorilla:plan or curl may not be in the list. Carrying it
     is the difference between an honest control and one that lies about what
     the card will actually run. */
  const offList = value !== null && !options.includes(value) ? [value] : [];

  const choices: SelectOption[] = [
    { value: '', label: neutralLabel, ...(hints?.[''] === undefined ? {} : { hint: hints[''] }) },
    ...[...options, ...offList].map((option) => ({
      value: option,
      label: option,
      ...(hints?.[option] === undefined ? {} : { hint: hints[option] }),
    })),
  ];

  return (
    <>
      {/* A line of padding, so a label sits on the first line of the field it
          names rather than on the field's top edge. */}
      <dt className="pt-1 text-dim" title={title}>
        {label}
      </dt>
      <dd>
        <Select
          className="w-full"
          label={label}
          title={title}
          value={value ?? ''}
          options={choices}
          onChange={(picked) => onPick(picked === '' ? null : picked)}
        />
      </dd>
    </>
  );
}

function Rail({
  title,
  children,
  className = '',
}: {
  title: string;
  children: ReactElement | ReactElement[];
  className?: string;
}) {
  return (
    /* `min-h-0` and `h-full` together are what make this scroll rather than
       grow: without them the section takes its content's height, the page
       stretches past the window, and the document scrollbar appears instead of
       this one - which loses the header and the group nav on the way down. */
    <section className={`h-full min-h-0 min-w-0 overflow-y-auto px-6 py-5 ${className}`}>
      {/* Full width. A centred measure left a margin either side of a pane the
          operator had deliberately expanded, which reads as the pane failing to
          fill the space it was given. The measure is kept where it matters
          instead - inside each section, which is narrow enough to read. */}
      <h3 className="sr-only">{title}</h3>
      {/* Each group owns its own column flow, so packing stays dense and the
          grouping survives. See the note on `.sections` in index.css. */}
      {children}
    </section>
  );
}

/**
 * A named break in the one surface.
 *
 * Full width and rule-bordered rather than a box, so it reads as a divider
 * between groups rather than as another section competing with the ones it
 * introduces. Carries the scroll target the tab bar jumps to.
 */
/**
 * How many columns a section takes.
 *
 * One by default. `full` is for content the measure works against - a diff, a
 * context file - which cannot reflow into a column at all.
 *
 * Two is for the section that is simply long. A section is a fixed width and
 * whatever height its content needs, so a section with a lot to say becomes a
 * narrow ribbon: the card's settings ran to 934 pixels in a 393-pixel column
 * and set the scroll length of the whole pane on their own, while two columns
 * beside them ended at 267 and stayed blank for the rest of the way down. Made
 * twice as wide, the same content is about half as tall, and the space it was
 * leaving beside itself is the space it now occupies.
 */
type Tracks = 1 | 2 | 'full';

function tracksFor(node: Element | null | undefined): Tracks {
  if (node?.classList.contains('section--wide') === true) return 'full';
  if (node?.classList.contains('section--pair') === true) return 2;
  return 1;
}

/** The row unit the spans are counted in. Matches `grid-auto-rows` in index.css. */
const ROW_PX = 4;
/** The gap between sections, added to each span so it does not need a row-gap. */
const SECTION_GAP_PX = 20;

/**
 * One section, given a row span from its own measured height.
 *
 * The measurement is the point: a grid row is as tall as the tallest thing in
 * it, so laying sections out on a coarse grid puts empty under every short
 * one. Counted against a four-pixel row instead, a section occupies exactly
 * the rows it needs and the next section in that column starts immediately
 * under it, which is what masonry is.
 *
 * Re-measured rather than measured once. Half the sections on this screen
 * change height while it is open - a disclosure is expanded, a run arrives, a
 * textarea is dragged taller - and a span fixed at first paint would leave a
 * gap or an overlap the moment any of that happened.
 */
function SectionItem({
  children,
  column,
  columns,
  onSpan,
}: {
  children: ReactNode;
  /** The column the group assigned, or null before it has decided. */
  column: number | null;
  /** How many tracks the group has. A pair cannot be honoured in fewer. */
  columns: number;
  onSpan: (span: number, tracks: Tracks) => void;
}): ReactElement {
  /**
   * Measured on the inner element, never on the outer one.
   *
   * The outer div's height is the span, so measuring it would ask the layout
   * what the layout already decided and freeze at whatever it guessed first.
   * The inner div is unconstrained, so its height is the content's own - and
   * because it exists from first paint, the observer is attached even for a
   * section whose content arrives with the data. Attaching to the section
   * itself missed exactly those, which left them at one row and overflowing
   * into the group below.
   */
  const inner = useRef<HTMLDivElement>(null);
  const [span, setSpan] = useState(1);
  const [tracks, setTracks] = useState<Tracks>(1);

  useEffect(() => {
    const node = inner.current;
    if (node === null) return;

    const measure = (): void => {
      const height = node.getBoundingClientRect().height;
      // One row of slack on top of the rounding. A span that comes out even a
      // pixel short lets the next section in the column sit on the bottom edge
      // of this one, and a four-pixel overshoot is invisible where an overlap
      // is the first thing anybody notices.
      const rows =
        height === 0 ? 1 : Math.max(1, Math.ceil((height + SECTION_GAP_PX) / ROW_PX) + 1);
      // Capped at what the window actually gave us. Asked to span two tracks
      // on a one-track grid, CSS invents a second one and the section hangs
      // off the side of the pane.
      const asked = tracksFor(node.firstElementChild);
      const wanted: Tracks = asked === 2 && columns < 2 ? 1 : asked;
      setSpan(rows);
      setTracks(wanted);
      // Reported up as the natural span so the group can choose columns from
      // heights it knows before the browser has placed anything.
      onSpan(rows, wanted);
    };

    measure();

    // Again once the fonts are in. Text measured against a fallback face is a
    // different height from the same text in IBM Plex, and every section
    // measured before the swap would be short by that difference.
    void document.fonts?.ready.then(measure).catch(() => {
      /* no font loading API; the first measurement stands */
    });

    // Guarded because the span is a layout refinement, not a correctness
    // requirement: without an observer every section keeps its first measured
    // height, which is wrong only for the ones that change.
    if (typeof ResizeObserver === 'undefined') return;

    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => {
      observer.disconnect();
    };
  }, [onSpan, columns]);

  return (
    <div
      className="min-w-0"
      style={{
        gridRowEnd: `span ${String(span)}`,
        /* The width is known from the class before any placement happens, and
           it has to be, or the section would be measured at one track's width
           and then laid out at two - which is a span computed for a paragraph
           that no longer exists. Only which column it starts in is the
           packer's to decide. */
        ...(tracks === 'full'
          ? { gridColumn: '1 / -1' }
          : column === null
            ? { gridColumn: `span ${String(tracks)}` }
            : { gridColumn: `${String(column)} / span ${String(tracks)}` }),
      }}
    >
      <div ref={inner} className="min-w-0">
        {children}
      </div>
    </div>
  );
}

/**
 * A group's sections, each measured.
 *
 * Wrapped rather than cloned: a section is an ordinary element and should not
 * have to accept a ref to be laid out. `Children.toArray` drops the nulls that
 * every conditional section renders when it has nothing to say.
 */
function SectionFlow({ children }: { children: ReactNode }): ReactElement {
  const items = flattenSections(children);
  const container = useRef<HTMLDivElement>(null);
  /** Natural spans, reported by each section once it has measured itself. */
  const [spans, setSpans] = useState<readonly (number | undefined)[]>([]);
  const [widths, setWidths] = useState<readonly Tracks[]>([]);
  const [columns, setColumns] = useState(0);

  const report = useCallback((index: number, span: number, tracks: Tracks): void => {
    setSpans((current) => {
      if (current[index] === span) return current;
      const next = [...current];
      next[index] = span;
      return next;
    });
    setWidths((current) => {
      if (current[index] === tracks) return current;
      const next = [...current];
      next[index] = tracks;
      return next;
    });
  }, []);

  /** How many tracks the width gave us. Read from the grid rather than guessed. */
  useEffect(() => {
    const node = container.current;
    if (node === null) return;

    const read = (): void => {
      setColumns(getComputedStyle(node).gridTemplateColumns.split(' ').filter(Boolean).length);
    };

    read();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(read);
    observer.observe(node);
    return () => {
      observer.disconnect();
    };
    // Re-read as the sections report in. At first paint the container has no
    // laid-out children and the computed tracks can come back as `none`, which
    // reads as one column and would leave the placement switched off for good -
    // the observer only fires when the box changes size, and it does not.
  }, [spans.length]);

  /**
   * Each section into the column that is currently shortest.
   *
   * This is the half of masonry that CSS will not do. `grid-auto-flow: dense`
   * fills holes but never chooses a column on the strength of how tall it
   * already is, so two tall sections that happen to be adjacent in the DOM end
   * up stacked in one column and the group finishes three hundred pixels
   * taller than it needed to, ragged on three sides.
   *
   * Greedy shortest-first is the standard answer and it is enough here: the
   * sections are independent boxes, so the only cost is that column order stops
   * matching DOM order, and the gain is a group that is both shorter and level.
   *
   * Computed from the reported spans, which are content-derived, so the same
   * content always produces the same columns. A full-width section levels every
   * column, because nothing may be laid out beside it.
   */
  const placement = useMemo<readonly (number | null)[]>(() => {
    const ready =
      columns > 1 && spans.length === items.length && spans.every((span) => span !== undefined);
    if (!ready) return items.map(() => null);

    const heights = new Array<number>(columns).fill(0);
    const chosen = new Array<number | null>(items.length).fill(null);

    /*
     * Tallest first, not in reading order.
     *
     * Greedy packing is only as good as the order it is fed. Walking the DOM,
     * the four short sections went down first and the tall one arrived last,
     * to be dropped on top of whichever column happened to be shortest - which
     * put a 706-pixel block under a 279-pixel one and made the pane 986 tall
     * while two columns ended at 311 and stayed blank the rest of the way.
     * Placed first, the same block starts at zero and the short sections fill
     * in beside it: 706, and four columns that end within seventy pixels of
     * each other.
     *
     * This is longest-processing-time scheduling, which is the standard
     * approximation for exactly this problem and is within a third of optimal
     * in the worst case. Reading order was already not preserved - see the
     * shortest-first note below - so what it costs here is the order of the
     * columns, and what it buys is a third off the length of the pane.
     */
    const order = items.map((_, index) => index).sort((a, b) => (spans[b] ?? 1) - (spans[a] ?? 1));

    for (const index of order) {
      const span = spans[index] ?? 1;
      const tracks = widths[index] ?? 1;

      if (tracks === 'full') {
        const below = Math.max(...heights) + span;
        heights.fill(below);
        continue;
      }

      if (tracks === 2) {
        /*
         * Into the adjacent pair that is currently shortest.
         *
         * A two-track section has to start somewhere it can also finish, so
         * the choice is over pairs rather than columns, and the cost of a pair
         * is its taller half - both of its columns resume underneath it.
         */
        let best = 0;
        let bestCost = Infinity;
        for (let start = 0; start + 1 < columns; start += 1) {
          const cost = Math.max(heights[start] ?? 0, heights[start + 1] ?? 0);
          if (cost < bestCost) {
            bestCost = cost;
            best = start;
          }
        }

        const below = bestCost + span;
        heights[best] = below;
        heights[best + 1] = below;
        chosen[index] = best + 1;
        continue;
      }

      const shortest = heights.indexOf(Math.min(...heights));
      heights[shortest] = (heights[shortest] ?? 0) + span;
      chosen[index] = shortest + 1;
    }

    return chosen;
  }, [columns, spans, widths, items.length]);

  return (
    <div className="sections" ref={container}>
      {items.map((child, index) => (
        <SectionItem
          key={isValidElement(child) && child.key !== null ? child.key : index}
          column={placement[index] ?? null}
          columns={columns}
          onSpan={(span, tracks) => {
            report(index, span, tracks);
          }}
        >
          {child}
        </SectionItem>
      ))}
    </div>
  );
}

/*
 * Squaring the columns off was tried and abandoned, 27 August 2026.
 *
 * A column of sections ends wherever its content ends, so a group finishes at
 * four different heights and the ragged edge reads as the page having run out.
 * Growing the bottom card in each short column closes it - and looked worse.
 * The space does not disappear, it moves inside the cards, and four cards each
 * carrying two hundred pixels of empty interior read as bloated where the
 * ragged bottom only read as uneven. A card's height should mean how much it
 * has to say.
 *
 * Recorded here rather than deleted, because the ragged bottom is the obvious
 * thing to want to fix and this is the second time it would have been tried.
 */

/**
 * Every section as its own item, fragments opened up.
 *
 * A fragment is one child to React and nine boxes to the reader. Left wrapped,
 * the brief's nine sections were a single 640-pixel column that nothing could
 * pack around - the tallest item in a group sets the group's height, so one
 * fragment was setting it for all of them. Opening the fragments turns one
 * indivisible block into nine placeable ones.
 *
 * Only fragments are opened. Anything else is a component that chose to render
 * what it renders, and taking it apart would be this layout overruling it.
 */
function flattenSections(children: ReactNode): ReactNode[] {
  return Children.toArray(children).flatMap((child) =>
    isValidElement(child) && child.type === Fragment
      ? flattenSections((child.props as { children?: ReactNode }).children)
      : [child],
  );
}

/**
 * The agent's own account of the run.
 *
 * Three kinds of line, kept visually apart on purpose. Thinking is what
 * produced the sentence after it, what it said is addressed to the operator,
 * and what it did is neither - flattening them into one column is how a
 * transcript stops being readable, and the reason to build this at all was that
 * a running card showed nothing.
 *
 * Its own scroll rather than the page's: a run is tens of thousands of lines
 * and the rest of the card is a handful of boxes. Sharing one scrollbar would
 * bury every other section under the transcript.
 */
function Narration({
  narration,
  error,
  running,
  limit,
  onMore,
}: {
  narration: NarrationModel | null;
  /** Why there is nothing, when there is a reason worth acting on. */
  error: string | null;
  running: boolean;
  limit: number;
  onMore: () => void;
}): ReactElement {
  const foot = useRef<HTMLDivElement>(null);
  const shown = narration?.entries?.length ?? 0;

  useEffect(() => {
    // Follows the run, which is the whole point while a card is live. Only
    // while running: yanking a reader to the bottom of a finished transcript
    // they were scrolling through would be a bug.
    if (running) foot.current?.scrollIntoView({ block: 'nearest' });
  }, [shown, running]);

  if (narration === null) {
    return (
      <div className="section section--wide">
        <h4 className="mb-1 eyebrow">Model thinking</h4>
        {/* "Reading the transcript" is only true while it is being read. Left
            up after a failed request it is a sentence that never becomes
            correct, and the operator waits for a screen that will never
            arrive. */}
        {error === null ? (
          <p className="text-dim">Reading the transcript.</p>
        ) : (
          <p className="text-danger">{error}</p>
        )}
      </div>
    );
  }

  const hidden = (narration.total ?? shown) - shown;

  return (
    <div className="section section--wide">
      <h4 className="mb-1 eyebrow">
        Model thinking
        {narration.provider === null ? '' : ` · ${narration.provider}`}
      </h4>

      {/* Said before the entries, not after. An operator who reads to the
          bottom looking for reasoning that was never handed over has already
          concluded the feature is broken. */}
      {narration.note === null ? null : (
        <p className="mb-2 border-l-2 border-attention pl-2 t-small text-dim">{narration.note}</p>
      )}

      {shown === 0 ? (
        <p className="text-dim">
          {running
            ? 'Nothing recorded yet. This fills in as the agent works.'
            : 'Nothing was recorded for this card.'}
        </p>
      ) : (
        <>
          {hidden > 0 ? (
            <button
              type="button"
              className="mb-2 t-small text-info hover:underline"
              onClick={onMore}
            >
              {`Show earlier — ${String(hidden)} of ${String(narration.total)} not shown`}
            </button>
          ) : null}

          <div className="max-h-[62vh] overflow-y-auto pr-1">
            <ol className="flex flex-col gap-2">
              {narration.entries.map((entry) => (
                <li key={`${entry.runId}:${String(entry.seq)}`}>
                  <NarrationLine entry={entry} />
                </li>
              ))}
            </ol>
            <div ref={foot} />
          </div>
        </>
      )}

      {limit >= 5_000 && hidden > 0 ? (
        <p className="mt-2 t-small text-faint">
          This is as far back as one request goes. The rest is in the transcript on disk.
        </p>
      ) : null}
    </div>
  );
}

/** One line of the account, styled by what kind of thing it is. */
function NarrationLine({ entry }: { entry: NarrationEntry }): ReactElement {
  if (entry.kind === 'did') {
    return (
      <div className="flex items-baseline gap-2 t-small">
        <span className="shrink-0 font-mono text-faint">did</span>
        <span className="font-mono text-ink">{entry.tool ?? 'tool'}</span>
        {entry.text === '' ? null : (
          <span className="min-w-0 truncate text-dim" title={entry.text}>
            {entry.text}
          </span>
        )}
      </div>
    );
  }

  if (entry.kind === 'thinking') {
    return (
      // Set back and quieter than speech. It is the largest thing here and the
      // least often the thing being looked for, so it reads as an aside rather
      // than as the main column of text.
      <div className="border-l-2 border-line pl-2.5">
        <div className="eyebrow mb-0.5 text-faint">thinking</div>
        <p className="whitespace-pre-wrap t-small leading-[1.5] text-dim">{entry.text}</p>
      </div>
    );
  }

  if (entry.kind === 'asked') {
    return (
      <div className="rounded-md bg-well px-2.5 py-1.5">
        <div className="eyebrow mb-0.5 text-faint">asked</div>
        <p className="whitespace-pre-wrap t-small leading-[1.5] text-dim">{entry.text}</p>
      </div>
    );
  }

  return <p className="whitespace-pre-wrap t-small leading-[1.55] text-ink">{entry.text}</p>;
}

/** The four panes, in the order the tab bar shows them. */
type Pane = 'brief' | 'specification' | 'thinking' | 'review';

/**
 * The flap: a pane over the board, anchored to the bottom of it.
 *
 * Over rather than instead of. The card took the whole window for a while, and
 * taking the window is what let its four groups run end to end into one
 * scroll - there was room, so nothing had to be chosen. Reading a card is
 * usually a question asked about a board that is still the thing being worked
 * on, and the columns above are the answer's context: which column this card
 * is in, and what else is in it.
 *
 * Eighty per cent, and not draggable. The old flap opened at 48% with a drag
 * handle, which meant resizing on the way into almost every card; the height
 * that people dragged to is simply the height it opens at now, and the strip
 * of board left over is enough to keep the place.
 */
const FLAP =
  'flap absolute inset-x-0 bottom-0 z-30 flex flex-col overflow-hidden rounded-t-xl ' +
  'border-t border-line bg-surface shadow-[0_-10px_36px_rgba(0,0,0,0.22)]';

export function CardDetail({
  cardId,
  onClose,
  onCompare,
}: {
  cardId: string;
  onClose: () => void;
  /** Opens this card beside another. Absent when the board cannot show one. */
  onCompare?: (otherCardId: string) => void;
}): ReactElement {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [brief, setBrief] = useState<Brief | null>(null);
  const [copied, setCopied] = useState(false);
  const [subagents, setSubagents] = useState<readonly Subagent[]>([]);
  const [proposals, setProposals] = useState<readonly GuardrailProposal[]>([]);
  /** The context file an agent dispatched now would be handed, verbatim. */
  const [agentContext, setAgentContext] = useState<string | null>(null);
  const [contextOpen, setContextOpen] = useState(false);
  /** The file whose diff is open, and its text. One at a time (T31). */
  const [openDiff, setOpenDiff] = useState<{ path: string; text: string } | null>(null);
  const [retrying, setRetrying] = useState(false);
  /** A scoped resync in flight, and what it came back with. */
  const [checking, setChecking] = useState(false);
  const [checkedNote, setCheckedNote] = useState<string | null>(null);
  const [retryNote, setRetryNote] = useState('');
  const [reviewing, setReviewing] = useState(false);
  const [reviewNote, setReviewNote] = useState<string | null>(null);
  const [siblings, setSiblings] = useState<readonly Card[]>([]);
  const [showEntries, setShowEntries] = useState(false);
  // Keep the dense material mutually exclusive. The board stays visible above
  // this pane, so opening detail should clarify a decision, not replace one
  // wall of cards with three smaller walls of text.
  const [activePane, setActivePane] = useState<Pane>('brief');
  const [narration, setNarration] = useState<NarrationModel | null>(null);
  const [narrationError, setNarrationError] = useState<string | null>(null);
  /** How far back the operator has asked to see. */
  const [narrationLimit, setNarrationLimit] = useState(400);
  const [error, setError] = useState<string | null>(null);
  const [timelineRunId, setTimelineRunId] = useState<string | null>(null);
  const [merging, setMerging] = useState(false);
  const [mergeReport, setMergeReport] = useState<MergeReport | null>(null);
  /** Set only when the gate declined. Judgement is offered here and nowhere else. */
  const [mergeRefusal, setMergeRefusal] = useState<{ summary: string; reach: string } | null>(null);
  /** What the resolver did, or why it could not. */
  const [resolution, setResolution] = useState<string | null>(null);

  /**
   * Merges this card alone.
   *
   * The same reviewer the morning batch uses, given one card: it merges, runs
   * the card's verify, and stops with the conflict left in the tree if anything
   * breaks. The server moves a merged card to the terminal column, so "merged"
   * and "done" cannot drift apart.
   */
  const mergeThisCard = useCallback(() => {
    if (detail === null) return;
    setMerging(true);
    setMergeReport(null);
    setMergeRefusal(null);

    void api
      .mergeCards(detail.card.boardId, {
        cardIds: [detail.card.id],
        ...(detail.mergeTarget === null ? {} : { into: detail.mergeTarget }),
        verify: detail.verifyCommand,
      })
      .then((report) => {
        setMergeReport(report);
        return api.cardDetail<Detail>(cardId);
      })
      .then((refreshed) => {
        if (refreshed !== null) setDetail(refreshed);
      })
      .catch((cause: Error & { refusal?: { summary: string; reach: string } }) => {
        // A refusal is not an error to report at the top of the pane: it is the
        // gate working, and it comes with something to do about it.
        if (cause.refusal !== undefined) setMergeRefusal(cause.refusal);
        else setError(cause.message);
      })
      .finally(() => setMerging(false));
  }, [cardId, detail]);

  /**
   * Whether the last attempt left a conflict in the tree.
   *
   * Read from the report rather than tracked separately, so the button and the
   * report cannot disagree about what state the repository is in.
   */
  const conflicted = mergeReport?.stoppedAt?.outcome === 'conflicted';

  /** Things on this card nobody has read yet. The gate refuses a merge on these. */
  const outstanding = brief?.surprises.length ?? 0;

  /** The card's guardrails, or an empty set when the response omits them. */
  const rails = detail?.guardrails ?? NO_GUARDRAILS;

  /**
   * Whether the outstanding set is actually stopping something.
   *
   * The distinction matters for where judgement is asked for. A card with no
   * worktree, or one already merged, has nothing blocked, so raising it there
   * would be the standing nag this was moved away from. A card whose merge is
   * disabled has to explain itself, or the disabled button is a wall.
   */
  const mergeBlocked =
    outstanding > 0 &&
    detail !== null &&
    detail.workspace !== null &&
    detail.card.mergedAt === null;

  /**
   * Resolves the conflict and completes the merge.
   *
   * The result is judged from git afterwards - no conflicted files, no merge in
   * progress, the operator's verify passing - because a resolver's own account of
   * what it did is exactly the kind of claim this board exists not to rely on.
   */
  const resolveThisConflict = useCallback(() => {
    if (detail === null) return;
    setMerging(true);

    void api
      .resolveConflicts(detail.card.boardId, {
        ...(detail.workspace === null ? {} : { branch: detail.workspace.branch }),
        ...(detail.mergeTarget === null ? {} : { into: detail.mergeTarget }),
        verify: detail.verifyCommand,
      })
      .then((result) => {
        setMergeReport(null);
        setResolution(result.detail);
        return api.cardDetail<Detail>(cardId);
      })
      .then((refreshed) => {
        if (refreshed !== null) setDetail(refreshed);
      })
      .catch((cause: Error) => setResolution(cause.message))
      .finally(() => setMerging(false));
  }, [cardId, detail]);

  /**
   * Records a verdict, then re-reads the brief.
   *
   * Refetched rather than patched locally: rejecting an entry changes which
   * sections assert what, and recomputing that here would be a second
   * implementation of the rule that could drift from the server's.
   */
  const judge = useCallback(
    (target: Surprise['target'], status: 'accepted' | 'rejected') => {
      if (target.type !== 'entry') return;

      void api
        .judgeEntry(target.entryId, { status })
        .then(() => api.cardBrief<Brief>(cardId))
        .then((refreshed) => {
          if (refreshed !== null) setBrief(refreshed);
        })
        .catch((cause: Error) => setError(cause.message));
    },
    [cardId],
  );

  /**
   * Puts the exported brief on the clipboard.
   *
   * Fetched rather than assembled from `brief.markdown`: the export carries a
   * provenance footer the on-screen text does not, and a copy that silently
   * differed from the download would be two exports claiming to be one.
   */
  const copyMarkdown = useCallback(async (): Promise<void> => {
    try {
      // Text, not JSON, so it does not go through the typed client. Named on
      // the client anyway, so every url this component knows lives in one file.
      await navigator.clipboard.writeText(await api.cardBriefMarkdown(cardId));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2_000);
    } catch (cause) {
      setError((cause as Error).message);
    }
  }, [cardId]);

  /** Save a model choice, then re-read the card so the rail shows what is stored. */
  const patch = useCallback(
    (body: Parameters<typeof api.updateCard>[1]) => {
      void api
        .updateCard(cardId, body)
        .then((card) => {
          setDetail((current) => (current === null ? current : { ...current, card }));
        })
        .catch((cause: Error) => setError(cause.message));
    },
    [cardId],
  );

  useEffect(() => {
    // Escape closes the card, like the overlay panels (T78, T79). Without it
    // the only way out of the busiest screen in the product is a mouse.
    function onKey(event: KeyboardEvent): void {
      if (event.key === 'Escape') onClose();
    }

    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  /**
   * Follows the account while the card is live.
   *
   * Polled rather than pushed. The server caches its parse on the transcript's
   * size and mtime, so a poll where nothing has moved costs one `stat` - and a
   * second stream, kept open per open card, would be more machinery than this
   * is worth. Only while running: a finished card is read once.
   */
  useEffect(() => {
    let cancelled = false;
    const running = detail?.card.status === 'running';

    async function read(): Promise<void> {
      try {
        const next = await api.cardNarration(cardId, narrationLimit);
        // Shape-checked rather than trusted, like every other loader on this
        // screen. A section whose body was not what it expected must not be
        // able to stop the card opening.
        if (cancelled || !Array.isArray(next.entries)) return;
        setNarration(next);
        setNarrationError(null);
      } catch (cause) {
        if (cancelled) return;

        // A 404 on a route this page knows about means the server is older
        // than the page calling it - the board is served from `dist/web`,
        // which a rebuild replaces under a process still running the previous
        // `dist/server`. Saying so beats leaving "Reading the transcript." on
        // screen for ever, which is what this did before and is a sentence
        // that was not true.
        const status = (cause as Error & { status?: number }).status;
        setNarrationError(
          status === 404
            ? 'This board is running an older build than this page: the route it needs answers 404. Restart it with `npm start`.'
            : (cause as Error).message,
        );
      }
    }

    void read();
    if (!running) return;

    const timer = setInterval(() => void read(), 2_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [cardId, narrationLimit, detail?.card.status]);

  useEffect(() => {
    let cancelled = false;

    async function load(): Promise<void> {
      try {
        // Every one of these is shape-checked by the client and answers null
        // rather than throwing. Only the detail is load-bearing; the rest are
        // sections, and a card that will not open is worse than a card missing
        // one of them.
        const [detail, brief, subagentList, shortlist, context] = await Promise.all([
          api.cardDetail<Detail>(cardId),
          api.cardBrief<Brief>(cardId),
          api.cardSubagents<Subagent>(cardId),
          api.cardProposals<GuardrailProposal>(cardId),
          // A section, not the card. If it fails the card still opens.
          api.cardContext(cardId).catch(() => null),
        ]);

        if (cancelled) return;

        // Shape-checked here rather than trusted. Every other loader on this
        // screen answers null rather than throwing, and a card that will not
        // open because one section's body was not what it expected is worse
        // than a card missing that section.
        if (typeof context?.context === 'string') setAgentContext(context.context);
        if (shortlist !== null) setProposals(shortlist);
        if (subagentList !== null) setSubagents(subagentList);

        if (detail === null) throw new Error('Could not load this card.');
        setDetail(detail);

        if (brief !== null) setBrief(brief);

        // Marked seen only after the brief has been computed. The other order
        // makes "since you last looked" permanently empty, because opening the
        // card would move the line the brief is measured against.
        await api.markSeenQuietly(cardId);
      } catch (cause) {
        if (!cancelled) setError((cause as Error).message);
      }
    }

    void load();

    return () => {
      cancelled = true;
    };
  }, [cardId]);

  /**
   * Escape closes the flap.
   *
   * Innermost first: with a run's timeline open over this, Escape belongs to
   * the timeline, and closing both from one keypress would take the operator
   * two surfaces back from where they were looking.
   */
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || timelineRunId !== null) return;
      onClose();
    };

    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose, timelineRunId]);

  if (error !== null) {
    return (
      <div className={`${FLAP} px-4 py-3 text-danger`}>
        {error}{' '}
        <button type="button" className="underline" onClick={onClose}>
          close
        </button>
      </div>
    );
  }

  if (detail === null) {
    return <div className={`${FLAP} px-4 py-3 text-dim`}>Loading…</div>;
  }

  const entries = detail.runs.flatMap((run) => run.ledger.entries);
  const latest = detail.runs[detail.runs.length - 1];

  /**
   * The tab bar, with what each pane is holding.
   *
   * The count belongs on the tab and not inside the pane: a tab that only says
   * "Model thinking" gives the operator no reason to open it, and the reason
   * to open it - that there are two hundred lines in there - is exactly what
   * the pane cannot say while it is closed.
   */
  const panes: readonly (readonly [Pane, string])[] = [
    ['brief', brief === null ? 'Brief' : `Brief · ${brief.unseenCount} new`],
    ['specification', 'Specification'],
    [
      'thinking',
      narration === null || narration.total === 0
        ? 'Model thinking'
        : `Model thinking · ${String(narration.total)}`,
    ],
    ['review', detail.runs.length === 0 ? 'Review' : `Review · ${runsSummary(detail.runs)}`],
  ];
  /** Names the open pane for a screen reader. The tab bar names it for the eye. */
  const paneLabel = panes.find(([pane]) => pane === activePane)?.[1] ?? 'Card';

  return (
    <div className={`${FLAP} h-[80%]`} aria-label={detail.card.title}>
      <header className="flex shrink-0 items-baseline gap-3 border-b border-line px-5 py-3">
        {/* First, and a close rather than a back: the board it would send you
            back to is on the screen already, behind this. */}
        <button
          type="button"
          title="Close (Esc)"
          className="-ml-1 inline-flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 t-small text-dim transition-colors hover:bg-well hover:text-ink"
          onClick={onClose}
        >
          <X size={13} aria-hidden />
          Close
        </button>
        <h2 className="min-w-0 truncate text-ink" title={detail.card.title}>
          {detail.card.title}
        </h2>
        <span className="shrink-0 t-small text-dim">{detail.card.status}</span>
        {/* Only on a card that stopped. Offering it on a running card would
            invite two runs in one worktree, and the server refuses that
            anyway - a button that returns 409 is worse than no button. */}
        {detail.card.status !== 'blocked' && detail.card.status !== 'abandoned' ? null : (
          <button
            type="button"
            className="ml-auto rounded border border-line px-2 py-0.5 t-small text-dim hover:text-ink"
            title="Sends the card back to the queue, keeping its worktree, with what you say about it."
            onClick={() => setRetrying(true)}
          >
            retry
          </button>
        )}
        {/* The sweep asks about every suspect card on the board; this asks
            about the one already open. Pointing at a card is a better signal
            than any heuristic, so this one skips the filter entirely - it is
            the only way to ask about a card the sweep would never consider. */}
        <button
          type="button"
          disabled={checking}
          title="Ask a cheap agent to read the repository and say whether this card's work is already there."
          className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 t-small text-dim transition-colors hover:bg-well hover:text-ink disabled:cursor-not-allowed disabled:opacity-60"
          onClick={() => {
            setChecking(true);
            setCheckedNote(null);
            void api
              .resync(detail.card.boardId, cardId)
              .then((report) => {
                setCheckedNote(report.error ?? report.findings[0]?.evidence ?? report.note);
                return api.cardDetail<Detail>(cardId);
              })
              .then((refreshed) => {
                if (refreshed !== null) setDetail(refreshed);
              })
              .catch((cause: Error) => setError(cause.message))
              .finally(() => setChecking(false));
          }}
        >
          <MagnifyingGlass size={13} aria-hidden />
          {checking ? 'Reading the repo' : 'Already done?'}
        </button>

        {/* The best template on a board is the card that worked last week, so
            there is no template store to keep - just this. */}
        <button
          type="button"
          className={`${detail.card.status === 'blocked' || detail.card.status === 'abandoned' ? '' : 'ml-auto '}inline-flex items-center gap-1.5 rounded-md px-2 py-1 t-small text-dim transition-colors hover:bg-well hover:text-ink`}
          title="A new card with this one's body, guardrails, goal and model. Nothing that happened to this card comes with it."
          onClick={() => {
            void api.cloneCard(cardId).catch((cause: Error) => setError(cause.message));
          }}
        >
          <Copy size={13} aria-hidden />
          Clone
        </button>
        {/* Put away, not deleted. Deleting takes the runs, the ledger and the
            judgements with it - the history this product exists to keep. */}
        <button
          type="button"
          className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 t-small text-dim transition-colors hover:bg-well hover:text-ink"
          title="Takes this off the board and out of the queue. Its runs, ledger and judgements stay."
          onClick={() => {
            void api
              .archiveCard(cardId, true)
              .then(onClose)
              .catch((cause: Error) => setError(cause.message));
          }}
        >
          <Archive size={13} aria-hidden />
          Archive
        </button>
      </header>

      <nav
        role="tablist"
        className="flex shrink-0 items-center gap-5 border-b border-line bg-surface px-6"
        aria-label="Card detail sections"
      >
        {panes.map(([pane, label]) => (
          <button
            key={pane}
            type="button"
            role="tab"
            id={`tab-${pane}`}
            aria-selected={activePane === pane}
            aria-controls="card-pane"
            // An underline, not a tint. A tinted pill on a tinted bar was
            // invisible, and a bar whose current entry cannot be found is a
            // bar that has stopped being navigation.
            className={`-mb-px border-b-2 px-1 py-2 transition-colors ${
              activePane === pane
                ? 'border-brand font-medium text-ink'
                : 'border-transparent text-dim hover:text-ink'
            }`}
            onClick={() => setActivePane(pane)}
          >
            {label}
          </button>
        ))}
      </nav>

      {/* The agent's answer, under the header where the question was asked.
          Its own words: what it read and what was in it, which is the whole of
          what an operator has to go on when a card has just been refiled. */}
      {checkedNote === null ? null : (
        <div className="flex items-start gap-3 border-b border-line bg-well px-5 py-2">
          <p className="min-w-0 flex-1 t-small leading-snug text-dim">{checkedNote}</p>
          <button
            type="button"
            className="shrink-0 t-small text-faint transition-colors hover:text-ink"
            onClick={() => setCheckedNote(null)}
          >
            Dismiss
          </button>
        </div>
      )}

      {!retrying ? null : (
        <div className="flex items-baseline gap-2 border-b border-line bg-well px-4 py-2">
          <input
            className="flex-1 rounded border border-line bg-surface px-2 py-1 text-ink placeholder:text-dim"
            placeholder="What went wrong, or what to do differently. Optional."
            aria-label="Retry note"
            value={retryNote}
            onChange={(changed) => setRetryNote(changed.target.value)}
          />
          <button
            type="button"
            className="rounded border border-line px-2 py-1 t-small text-ink hover:border-dim"
            onClick={() => {
              void api
                .retryCard(detail.card.boardId, cardId, retryNote.trim() === '' ? null : retryNote)
                .then(() => {
                  setRetrying(false);
                  setRetryNote('');
                })
                .catch((cause: Error) => setError(cause.message));
            }}
          >
            send it back
          </button>
          <button
            type="button"
            className="rounded border border-line px-2 py-1 t-small text-dim hover:text-ink"
            onClick={() => setRetrying(false)}
          >
            cancel
          </button>
        </div>
      )}

      <div
        className="min-h-0 flex-1"
        id="card-pane"
        role="tabpanel"
        aria-labelledby={`tab-${activePane}`}
      >
        {/*
         * One pane at a time.
         *
         * The four groups were briefly laid end to end on one surface with the
         * tabs demoted to scroll shortcuts. That put a card's whole life -
         * its specification, its brief, its transcript and its runs - into a
         * single scroll, and the transcript alone is tens of thousands of
         * lines: everything below it became unreachable in practice, and the
         * tab bar advertised four destinations while offering one document.
         *
         * The tabs filter again. What each pane loses is the empty space a
         * short group used to leave, and that is answered by the masonry
         * inside the pane rather than by refusing to divide the card.
         */}
        <Rail title={paneLabel}>
          <>
            {activePane !== 'specification' ? null : (
              <SectionFlow>
                <div className="section">
                  <h4 className="mb-2 eyebrow">What this card is</h4>
                  {detail.card.body === '' ? (
                    <p className="text-dim">
                      No description. An agent reads this before anything else, so a card with none
                      is a card that starts from its title alone.
                    </p>
                  ) : (
                    <p className="whitespace-pre-wrap text-ink">{detail.card.body}</p>
                  )}
                </div>

                {/*
                 * What the agent will actually be handed.
                 *
                 * The literal text of `card-context.md`, not a description of it.
                 * A screen that paraphrased the context would be a second
                 * description to keep in step with the first, and on the day the
                 * two disagreed the operator would review against the wrong one.
                 *
                 * Wide, because it is preformatted and cannot reflow into a
                 * column, and closed by default, because it is long and the
                 * question it answers - "what does the agent know?" - is one an
                 * operator asks occasionally rather than every time they open a
                 * card. The summary line carries the answer for the other times.
                 */}
                {agentContext === null ? null : (
                  <div className={`section ${contextOpen ? 'section--wide' : ''}`}>
                    <h4 className="mb-2 eyebrow">What the agent will be told</h4>
                    <p className="mb-2 text-dim">
                      The context file handed to the session, as it would be written if this card
                      were dispatched now. Not a record of what an earlier run received: the ledger,
                      the dependencies and the subsystem map all move.
                    </p>
                    <p className="mb-3 t-small text-faint">
                      {`${String(agentContext.split('\n').length)} lines, ${String(agentContext.length)} characters. Sections: ${
                        agentContext
                          .split('\n')
                          .filter((line) => line.startsWith('## '))
                          .map((line) => line.slice(3))
                          .join(', ') || 'the card body alone'
                      }.`}
                    </p>
                    <button
                      type="button"
                      className="rounded-md border border-line px-2.5 py-1 t-small text-ink transition-colors hover:border-dim"
                      onClick={() => setContextOpen((open) => !open)}
                      aria-expanded={contextOpen}
                    >
                      {contextOpen ? 'Hide it' : 'Read it'}
                    </button>
                    {!contextOpen ? null : (
                      <pre className="mt-3 max-h-[420px] overflow-auto whitespace-pre-wrap rounded-md border border-line bg-well p-3 font-mono t-fine leading-[1.5] text-ink">
                        {agentContext}
                      </pre>
                    )}
                  </div>
                )}

                <div className="section">
                  <h4 className="mb-3 eyebrow">How it will run</h4>
                  {/* Labels to the top of their field, not the middle of it. The fields
                      grow to fit their value now, so "Goal" beside a
                      twenty-line condition sat two hundred pixels below the
                      first line it names. */}
                  <dl className="grid grid-cols-[auto_1fr] items-start gap-x-4 gap-y-2 t-small">
                    <FieldSelect
                      label="Priority"
                      value={detail.card.priority === 'normal' ? null : detail.card.priority}
                      options={['high', 'low']}
                      title="Reorders the dispatch queue within this card's column."
                      neutralLabel="normal"
                      hints={{
                        high: 'Dispatched before the rest of its column.',
                        '': 'Dispatched in board order.',
                        low: 'Dispatched after the rest of its column.',
                      }}
                      onPick={(priority) =>
                        patch({ priority: (priority ?? 'normal') as Card['priority'] })
                      }
                    />
                    <FieldSelect
                      label="Agent"
                      value={detail.card.agentProvider}
                      options={['claude', 'codex']}
                      title="The coding CLI dispatched for this card."
                      neutralLabel="claude"
                      hints={{
                        claude: 'Observed through hooks, as it runs.',
                        codex: 'Captured from its JSON stream.',
                      }}
                      onPick={(agentProvider) =>
                        patch({
                          agentProvider: (agentProvider ?? 'claude') as Card['agentProvider'],
                        })
                      }
                    />
                    <FieldSelect
                      label="Model"
                      value={detail.card.agentModel}
                      options={detail.card.agentProvider === 'codex' ? CODEX_MODELS : CLAUDE_MODELS}
                      title={`Reaches the selected ${detail.card.agentProvider} CLI for this card's run.`}
                      onPick={(agentModel) => patch({ agentModel })}
                    />
                    <FieldSelect
                      label="Effort"
                      value={detail.card.agentEffort}
                      options={EFFORTS}
                      title="Reaches `claude --effort` for this card's run."
                      onPick={(agentEffort) => patch({ agentEffort })}
                    />
                    <FieldSelect
                      label="Synthesis"
                      value={detail.card.synthesisModel}
                      options={CLAUDE_MODELS}
                      title="Used only for windows that escalate - compaction, and manual re-extraction. Not the model that does the work."
                      onPick={(synthesisModel) => patch({ synthesisModel })}
                    />
                  </dl>
                </div>

                {/*
                 * What the card has to satisfy, kept apart from who runs it.
                 *
                 * One box before this, and it was 934 pixels tall in a
                 * 393-pixel column - one section setting the scroll length of
                 * the whole pane while two columns beside it ended at 267 and
                 * stayed blank the rest of the way down.
                 *
                 * The seam is not arbitrary. Everything above is a choice from
                 * a list about how the work gets done, and everything here is
                 * something written out that the finished work has to meet.
                 * Splitting them was already the honest division; it is only
                 * that nothing forced the question until the box got too tall.
                 *
                 * Two columns wide, because these are the long values - a goal
                 * condition is a paragraph and a scope is a list of paths - and
                 * a paragraph in a 393-pixel column is a ribbon.
                 */}
                <div className="section section--pair">
                  <h4 className="mb-2 eyebrow">What it must satisfy</h4>
                  <dl className="grid grid-cols-[auto_1fr] items-start gap-x-4 gap-y-2 t-small">
                    <dt
                      className="pt-1 text-dim"
                      title="Tokens a run may spend before the board stops it. This one is enforced: the board terminates the session."
                    >
                      Ceiling
                    </dt>
                    <dd>
                      {/* Named as a hard limit rather than a preference. The board
                    kills the process when it is crossed, unlike the guardrails
                    below, which are written into settings and can be argued
                    with. */}
                      <TextField
                        label="token ceiling"
                        value={
                          detail.card.tokenCeiling === null ? '' : String(detail.card.tokenCeiling)
                        }
                        placeholder="no ceiling"
                        onSave={(next) =>
                          patch({ tokenCeiling: next.trim() === '' ? null : Number(next) })
                        }
                      />
                    </dd>
                    <dt
                      className="pt-1 text-dim"
                      title="What /goal is given. Without one, the card cannot be dispatched."
                    >
                      Goal
                    </dt>
                    <dd>
                      {/* Editable, because a card added from the board header has no
                    goal and therefore cannot be dispatched - the Add button led
                    to a dead end, and every real card had to be made by curl. */}
                      <TextField
                        label="goal condition"
                        value={detail.card.goalCondition ?? ''}
                        placeholder="measurable end state, a stated check, and a turn bound"
                        invalid={detail.card.goalCondition === null}
                        invalidNote="Not set, so this card cannot be dispatched."
                        onSave={(next) => patch({ goalCondition: next === '' ? null : next })}
                      />
                    </dd>
                    <dt
                      className="pt-1 text-dim"
                      title="A command the board runs itself after the run. Hard: the card halts if it does not pass."
                    >
                      Verify
                    </dt>
                    <dd>
                      <TextField
                        label="verify command"
                        value={detail.verifyCommand ?? ''}
                        placeholder="npm test"
                        onSave={(next) =>
                          patch({
                            guardrails: { ...rails, verify: next === '' ? null : next },
                          })
                        }
                      />
                    </dd>
                    <dt
                      className="pt-1 text-dim"
                      title="Paths the agent should confine itself to. Advisory: it is prompt text, not a rule."
                    >
                      Scope
                    </dt>
                    <dd>
                      <TextField
                        label="scope paths"
                        value={rails.scope.join(', ')}
                        placeholder="src/server/, test/"
                        onSave={(next) => patch({ guardrails: { ...rails, scope: asList(next) } })}
                      />
                    </dd>
                    <dt
                      className="pt-1 text-dim"
                      title="Hard where a rule names a path or a command pattern, advisory otherwise. The list below says which."
                    >
                      Prohibit
                    </dt>
                    <dd>
                      <TextField
                        label="prohibitions"
                        value={rails.prohibit.join(', ')}
                        placeholder="src/db/schema.ts, Bash(git push *)"
                        onSave={(next) =>
                          patch({ guardrails: { ...rails, prohibit: asList(next) } })
                        }
                      />
                    </dd>
                  </dl>
                </div>

                <div className="section">
                  <h4 className="mb-2 eyebrow">Guardrails</h4>
                  {detail.guardrailDetail.length === 0 ? (
                    <p className="text-dim">
                      None. Nothing constrains what this card&rsquo;s run may touch.
                    </p>
                  ) : (
                    <ul className="flex flex-col gap-2">
                      {detail.guardrailDetail.map((rail) => (
                        <li key={`${rail.kind}:${rail.text}`} className="leading-snug">
                          {/* A guardrail the board enforces and one it merely asks
                          for are different promises, so they are different
                          chips rather than the same word in two greys (R10). */}
                          <span
                            className={`chip mr-1.5 ${rail.enforcement === 'hard' ? 'chip-ok' : ''}`}
                            title={rail.because}
                          >
                            {rail.enforcement === 'hard' ? 'Enforced' : 'Asked for'}
                          </span>
                          <span className="text-ink">{rail.text}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>

                {detail.staleness?.suspect !== true ? null : (
                  /* A suspicion, never a verdict. The board says what it noticed and
                 what to look at; archiving a card it believed was finished would
                 eventually archive one that was not, and an operator burned that
                 way stops trusting the surface. */
                  <div className="mb-3 rounded border border-brand/50 bg-brand/5 px-2 py-1.5">
                    <h4 className="mb-1 eyebrow text-attention">This card may already be done</h4>
                    {detail.staleness.findings.map((finding) => (
                      <p key={finding.signal} className="mb-1 leading-snug text-ink">
                        {finding.detail}
                        {finding.evidence.length === 0 ? null : (
                          <span className="ml-1 t-fine text-dim">
                            ({finding.evidence.slice(0, 4).join(', ')})
                          </span>
                        )}
                      </p>
                    ))}
                    {detail.staleness.advice === null ? null : (
                      <p className="t-fine text-dim">{detail.staleness.advice}</p>
                    )}
                  </div>
                )}

                {detail.blockers.length > 0 ? (
                  <p className="mt-3 text-danger">
                    Blocked by: {detail.blockers.map((blocker) => blocker.title).join(', ')}
                  </p>
                ) : (
                  <></>
                )}
              </SectionFlow>
            )}
            {activePane !== 'brief' ? null : (
              <SectionFlow>
                {/* Verify output only when it did not pass. When it passed, the
                brief's one line is enough and a green box is just noise. */}
                {detail.verify === null || detail.verify.status === 'passed' ? null : (
                  <div className="mb-3 rounded border border-danger/40 bg-danger/10 px-2 py-1.5 text-danger">
                    {/* The board ran this. It does not depend on the agent
                    reporting honestly, which is the whole point (R10). */}
                    <div className="t-small">{detail.verifyNote}</div>
                    <pre className="mt-1 max-h-32 overflow-y-auto whitespace-pre-wrap font-mono t-fine text-dim">
                      {detail.verify.output}
                    </pre>
                  </div>
                )}

                {brief === null ? (
                  <p className="text-dim">The brief could not be loaded.</p>
                ) : (
                  <>
                    {brief.extraction.note === null ? null : (
                      <p className="mb-3 rounded border border-danger/40 bg-danger/10 px-2 py-1.5 t-small text-danger">
                        {brief.extraction.note}
                      </p>
                    )}

                    {mergeRefusal === null && !mergeBlocked ? null : (
                      <div className="mb-3 rounded border border-danger/50 bg-danger/10 px-2 py-1.5">
                        <h4 className="mb-1 eyebrow text-danger">
                          {mergeRefusal === null
                            ? `Merge is blocked: ${String(outstanding)} to read`
                            : 'The merge was refused'}
                        </h4>
                        <p className="mb-1 leading-snug text-ink">
                          {mergeRefusal?.summary ??
                            'These have not been read yet. Accept or reject each and the merge becomes available.'}
                        </p>
                        <p className="mb-2 t-fine text-dim">
                          {mergeRefusal?.reach ??
                            'This is the board declining to merge for you, not a lock on the repository. ' +
                              'A `git merge` run in a terminal will merge this branch with nothing to stop it.'}
                        </p>

                        {/* Shown when it is stopping something, and not otherwise.
                        Asking on every card view is a standing request the
                        operator learns to scroll past; asking beside a disabled
                        button is a question with its reason attached - and
                        without it, the disabled button would be a wall. */}
                        <ul className="flex flex-col gap-2">
                          {brief.surprises.map((surprise) => (
                            <li key={surprise.id} className="leading-snug">
                              <div className="text-ink">{surprise.headline}</div>
                              <div className="t-fine text-dim">{surprise.why}</div>
                              {surprise.target.type === 'path' ? (
                                <div className="t-fine text-dim">
                                  Not an entry, so there is nothing to accept: open the file.
                                </div>
                              ) : (
                                <div className="mt-0.5 flex gap-2">
                                  <button
                                    type="button"
                                    className="rounded border border-ok/50 px-1.5 t-fine text-ok hover:bg-ok/10"
                                    onClick={() => judge(surprise.target, 'accepted')}
                                  >
                                    accept
                                  </button>
                                  <button
                                    type="button"
                                    className="rounded border border-danger/50 px-1.5 t-fine text-danger hover:bg-danger/10"
                                    title="Kept on the card, but no longer stated as fact in the brief."
                                    onClick={() => judge(surprise.target, 'rejected')}
                                  >
                                    reject
                                  </button>
                                  {/* Rejecting says the run got something wrong.
                                  Without this the work that implies lives in
                                  the operator's head until they forget it. */}
                                  <button
                                    type="button"
                                    className="rounded border border-line px-1.5 t-fine text-dim hover:text-ink"
                                    title="Rejects this and raises a card to address it, linked back to here."
                                    onClick={() => {
                                      const entryId =
                                        surprise.target.type === 'entry'
                                          ? surprise.target.entryId
                                          : null;
                                      if (entryId === null) return;

                                      judge(surprise.target, 'rejected');
                                      void api
                                        .followUp(entryId)
                                        .catch((cause: Error) => setError(cause.message));
                                    }}
                                  >
                                    reject and raise a card
                                  </button>
                                </div>
                              )}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {brief.sections.map((section) => (
                      <div key={section.title} className="section">
                        <h4 className="mb-1 eyebrow">{section.title}</h4>
                        {section.lines.map((line, index) => (
                          <p
                            key={`${section.title}-${String(index)}`}
                            className={`whitespace-pre-wrap leading-snug ${
                              section.empty
                                ? 'text-dim'
                                : line.startsWith('REVERSED:')
                                  ? 'text-danger'
                                  : line.startsWith('Needs you:')
                                    ? 'text-brand'
                                    : 'text-ink'
                            }`}
                          >
                            {line}
                          </p>
                        ))}
                      </div>
                    ))}
                  </>
                )}

                {entries.length === 0 ? (
                  <></>
                ) : (
                  <div className="section">
                    <button
                      type="button"
                      className="t-small text-info hover:underline"
                      onClick={() => setShowEntries(!showEntries)}
                    >
                      {showEntries ? 'hide' : 'show'} the {entries.length} underlying entr
                      {entries.length === 1 ? 'y' : 'ies'}
                    </button>

                    {!showEntries ? null : (
                      <ul className="mt-2 flex flex-col gap-2">
                        {entries.map((entry, index) => (
                          <li
                            key={`${entry.kind}-${index}`}
                            className="border-l-2 border-line pl-2"
                          >
                            <span
                              className={`mr-1.5 t-fine uppercase ${
                                KIND_COLOUR[entry.kind] ?? 'text-dim'
                              }`}
                            >
                              {entry.kind}
                            </span>
                            <span className="text-ink">{entry.statement}</span>
                            {entry.detail === undefined ? null : (
                              <div className="mt-0.5 t-small text-dim">{entry.detail}</div>
                            )}
                            <div className="t-fine text-dim">
                              {/* Every entry names its evidence; nothing here is
                              unfalsifiable (doc 08). */}
                              {entry.sourceEventIds.length} source event(s)
                            </div>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}

                {detail.workspace === null || onCompare === undefined ? null : (
                  <div className="section">
                    {/* Most useful straight after cloning, which is why it sits on
                    the card rather than behind a selection on the board. */}
                    <div className="flex items-center gap-2">
                      <span className="t-small text-dim">compare with</span>
                      <Select
                        className="min-w-0 flex-1"
                        label="Compare this card with another"
                        value={null}
                        placeholder="another card"
                        options={siblings.map((sibling) => ({
                          value: sibling.id,
                          label: sibling.title,
                        }))}
                        onOpen={() => {
                          if (siblings.length > 0) return;
                          void api
                            .cards(detail.card.boardId)
                            .then((cards) =>
                              setSiblings(cards.filter((card) => card.id !== cardId)),
                            )
                            .catch((cause: Error) => setError(cause.message));
                        }}
                        onChange={(other) => onCompare(other)}
                      />
                    </div>
                  </div>
                )}

                {detail.workspace === null ? null : (
                  <div className="section">
                    {/* What it costs, before it is pressed. A button that quietly
                    spends a model call is one an operator presses twice. */}
                    <button
                      type="button"
                      className="rounded border border-line px-2 py-0.5 t-small text-dim hover:text-ink disabled:opacity-50"
                      disabled={reviewing}
                      title="Asks a session that did not write this branch to read it. One model call on your Claude Code quota. Anything it raises has to be judged before this merges."
                      onClick={() => {
                        setReviewing(true);
                        setReviewNote(null);
                        void api
                          .secondOpinion(cardId)
                          .then((result) => setReviewNote(result.note))
                          .catch((cause: Error) => setError(cause.message))
                          .finally(() => setReviewing(false));
                      }}
                    >
                      {reviewing ? 'reading the branch…' : 'ask for a second opinion'}
                    </button>
                    {reviewNote === null ? null : (
                      <p className="mt-1 t-small text-dim">{reviewNote}</p>
                    )}
                  </div>
                )}

                {(detail.readiness?.checks ?? []).length === 0 ? null : (
                  <div className="section">
                    <h4 className="mb-1 eyebrow">Before you merge</h4>
                    <ul className="flex flex-col gap-0.5 t-small">
                      {(detail.readiness?.checks ?? []).map((check) => (
                        <li key={check.name} className="flex items-start gap-2 text-dim">
                          {/* Three states, not two. A check the board could not run
                          and a check that passed are the two things this list
                          exists to keep apart, so the third has its own mark
                          rather than borrowing one of the others. */}
                          {check.state === 'settled' ? (
                            <CheckCircle
                              size={15}
                              className="mt-0.5 shrink-0 text-ok"
                              aria-label="Settled"
                            />
                          ) : check.state === 'needs-you' ? (
                            <Warning
                              size={15}
                              className="mt-0.5 shrink-0 text-danger"
                              aria-label="Needs you"
                            />
                          ) : (
                            <Question
                              size={15}
                              className="mt-0.5 shrink-0 text-faint"
                              aria-label="Not known"
                            />
                          )}
                          <span>
                            <span className="text-ink">{check.name}</span> {check.detail}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {detail.mergeForecast === undefined || !detail.mergeForecast.readable ? null : (
                  <p
                    className={`mt-3 ${detail.mergeForecast.clean ? 'text-dim' : 'text-danger'}`}
                    title="Asked with git merge-tree, which touches neither the working tree nor HEAD."
                  >
                    {detail.mergeForecast.note}
                  </p>
                )}

                {detail.diff === undefined || !detail.diff.readable ? null : (
                  <div className="section">
                    <h4 className="mb-1 eyebrow">
                      Diff ({detail.diff.files.length} file(s), +{detail.diff.insertions} −
                      {detail.diff.deletions})
                    </h4>
                    {/* Reviewing used to mean leaving the board for a terminal,
                    which is where the operator loses the context the board
                    exists to hold. */}
                    <ul className="flex flex-col gap-0.5 t-small">
                      {detail.diff.files.map((file) => (
                        <li key={file.path}>
                          <button
                            type="button"
                            className="text-left text-dim hover:text-ink"
                            onClick={() => {
                              void api
                                .cardDiff(cardId, file.path)
                                .then((text) => setOpenDiff({ path: file.path, text }))
                                .catch((cause: Error) => setError(cause.message));
                            }}
                          >
                            <span className="text-ink">{file.path}</span>{' '}
                            {/* Git reports no line counts for a binary file.
                            Printing zeroes would read as 'changed nothing'. */}
                            {file.binary ? (
                              'binary'
                            ) : (
                              <>
                                <span className="text-ok">+{file.insertions}</span>{' '}
                                <span className="text-danger">−{file.deletions}</span>
                              </>
                            )}
                          </button>
                        </li>
                      ))}
                    </ul>

                    {openDiff === null ? null : (
                      <div className="mt-2 border-t border-line pt-2">
                        <div className="mb-1 flex items-baseline gap-2">
                          <span className="font-mono t-small text-ink">{openDiff.path}</span>
                          <button
                            type="button"
                            className="t-small text-dim hover:text-ink"
                            onClick={() => setOpenDiff(null)}
                          >
                            close
                          </button>
                        </div>
                        <pre className="max-h-96 overflow-auto whitespace-pre bg-well p-2 font-mono t-small text-dim">
                          {openDiff.text}
                        </pre>
                      </div>
                    )}
                  </div>
                )}

                {proposals.length === 0 ? null : (
                  <div className="section">
                    <h4 className="mb-1 eyebrow">Worth making a rule ({proposals.length})</h4>
                    {/* Proposals, never applied on their own. An entry becoming a
                    rule without a human reading it would let the ledger
                    constrain the agent by itself, which doc 12 never allows. */}
                    <ul className="flex flex-col gap-2 t-small">
                      {proposals.map((proposal) => (
                        <li key={proposal.entryId} className="border-l-2 border-line pl-2">
                          <div className="text-ink">{proposal.statement}</div>
                          <div className="text-dim">
                            {proposal.target}
                            {' · '}
                            {/* Stated before the operator commits, not after. */}
                            <span
                              className={
                                proposal.enforcement === 'hard' ? 'text-ok' : 'text-danger'
                              }
                            >
                              {proposal.enforcement}
                            </span>
                            {' · '}
                            {proposal.why}
                          </div>
                          <button
                            type="button"
                            className="text-info hover:underline"
                            onClick={() => {
                              void api
                                .promoteEntry(proposal.entryId, {
                                  target: proposal.target,
                                  rule: proposal.rule,
                                })
                                .then((result) => {
                                  setProposals((current) =>
                                    current.filter((entry) => entry.entryId !== proposal.entryId),
                                  );
                                  setDetail((current) =>
                                    current === null ? current : { ...current, card: result.card },
                                  );
                                })
                                .catch((cause: Error) => setError(cause.message));
                            }}
                          >
                            make it a {proposal.target} rule
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {(detail.contradictions ?? []).length === 0 ? null : (
                  <div className="section">
                    <h4 className="mb-1 eyebrow text-danger">Runs into a project rule</h4>
                    <ul className="flex flex-col gap-1 t-small">
                      {(detail.contradictions ?? []).map((entry) => (
                        <li key={`${entry.invariant}-${entry.conflict}`} className="text-dim">
                          {/* Scope is a claim about where the work will happen. A
                          mention in the body is weaker - a card can name a file
                          it intends to leave alone - so which it is gets said. */}
                          {entry.where === 'scope' ? 'scoped to' : 'mentions'}{' '}
                          <span className="text-ink">{entry.conflict}</span>, against “
                          {entry.invariant}”
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {(detail.blastRadius?.paths ?? []).length === 0 ? null : (
                  <div className="section">
                    <h4 className="mb-1 eyebrow">Cards like this touched</h4>
                    {/* A guess from similar wording, said as one. 'These files'
                    invites acceptance; 'these files, because these cards
                    touched them' invites checking, which is what an operator
                    should do with a guess. */}
                    <ul className="flex flex-col gap-0.5 t-small">
                      {(detail.blastRadius?.paths ?? []).slice(0, 8).map((entry) => (
                        <li key={entry.path} className="text-dim">
                          <span className="text-ink">{entry.path}</span> · {entry.cards} card(s)
                        </li>
                      ))}
                    </ul>
                    <p className="mt-1 text-dim">
                      From{' '}
                      {(detail.blastRadius?.from ?? []).map((card) => `“${card.title}”`).join(', ')}
                      .
                    </p>
                  </div>
                )}

                {(detail.subsystems ?? []).length === 0 ? null : (
                  <div className="section">
                    <h4 className="mb-1 eyebrow">Touched</h4>
                    <ul className="flex flex-col gap-0.5 t-small">
                      {(detail.subsystems ?? []).map((entry) => (
                        <li key={entry.subsystem} className="text-dim">
                          <span className="text-ink">{entry.subsystem}</span> · {entry.paths}{' '}
                          file(s)
                        </li>
                      ))}
                    </ul>

                    {(detail.claimedNotInGit ?? []).length === 0 ? null : (
                      <p className="mt-1 text-dim">
                        {/* Phrased as a question. Work reverted before the commit
                        and files written outside the worktree both land here,
                        and neither is a run lying. */}
                        {(detail.claimedNotInGit ?? []).length} path(s) the run mentioned are not in
                        the branch: {(detail.claimedNotInGit ?? []).join(', ')}.
                      </p>
                    )}
                  </div>
                )}

                {(detail.relatedCards ?? []).length === 0 ? null : (
                  <div className="section">
                    <h4 className="mb-1 eyebrow">Also worked here</h4>
                    {/* The point of the map: whatever an earlier card learned about
                    these files was learned the expensive way. */}
                    <ul className="flex flex-col gap-0.5 t-small">
                      {(detail.relatedCards ?? []).map((related) => (
                        <li key={related.cardId} className="text-dim">
                          <span className="text-ink">{related.title}</span> ·{' '}
                          {related.shared.length} shared file(s)
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {detail.realityNotes.length > 0 ? (
                  <div className="section">
                    <h4 className="mb-1 eyebrow">Claim versus reality</h4>
                    {detail.realityNotes.map((note) => (
                      <p key={note} className="text-dim">
                        {note}
                      </p>
                    ))}
                  </div>
                ) : (
                  <></>
                )}

                {brief === null ? null : (
                  // A brief that stays on this screen is a brief the rest of the
                  // team never reads. The two exits are copy, for a pull request
                  // body or a message, and download, for something kept.
                  //
                  // Wraps rather than squeezing: in a 320px column the label and
                  // two buttons on one line broke "Export" across two lines and
                  // left the buttons stacked mid-word.
                  <div className="section flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="eyebrow mr-1 whitespace-nowrap">Export</span>
                    <button
                      type="button"
                      className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 t-small text-dim transition-colors hover:bg-well hover:text-ink"
                      onClick={() => void copyMarkdown()}
                    >
                      <Copy size={13} aria-hidden />
                      <span className="whitespace-nowrap">
                        {copied ? 'Copied' : 'Copy markdown'}
                      </span>
                    </button>
                    <a
                      className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 t-small text-dim transition-colors hover:bg-well hover:text-ink"
                      href={`/api/cards/${cardId}/brief.md`}
                      download
                    >
                      <DownloadSimple size={13} aria-hidden />
                      <span className="whitespace-nowrap">Download .md</span>
                    </a>
                  </div>
                )}
              </SectionFlow>
            )}
            {activePane !== 'thinking' ? null : (
              <SectionFlow>
                <Narration
                  narration={narration}
                  error={narrationError}
                  running={detail.card.status === 'running'}
                  limit={narrationLimit}
                  onMore={() => setNarrationLimit((current) => Math.min(current * 4, 5_000))}
                />
              </SectionFlow>
            )}
            {activePane !== 'review' ? null : (
              <SectionFlow>
                {detail.runs.length === 0 ? (
                  <div className="section">
                    <h4 className="mb-1 eyebrow">Nothing to review</h4>
                    <p className="text-dim">
                      Nothing has been dispatched against this card, so there is no run to read.
                    </p>
                  </div>
                ) : (
                  <ul className="mb-3 flex flex-col gap-2 t-small">
                    {detail.runs.map((run) => {
                      const ended = endedNote(run);
                      return (
                        <li key={run.runId} className="border-l-2 border-line pl-2">
                          <div className="text-ink">
                            {run.sessionId.slice(0, 8)}
                            <span className="ml-1.5 text-dim">
                              {run.mode}
                              {run.runId === latest?.runId ? ' · latest' : ''}
                            </span>
                          </div>
                          <div className="text-dim">
                            {new Date(run.startedAt).toLocaleString()} · {run.events} events
                          </div>
                          {/* Silent when nothing was recorded. A run with no usage
                          and a run that cost nothing are different facts, and
                          printing "0 tokens" would state the second. */}
                          {run.cost === null ? null : (
                            <div className="text-dim">{run.cost.summary}</div>
                          )}
                          <div className={ended.tone}>{ended.text}</div>
                          {run.goalOutcome === null ? null : (
                            <div className="text-dim">goal: {run.goalOutcome}</div>
                          )}
                          <button
                            type="button"
                            className="text-info hover:underline"
                            onClick={() => setTimelineRunId(run.runId)}
                          >
                            timeline
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}

                {subagents.length === 0 ? null : (
                  <div className="section">
                    <h4 className="mb-1 eyebrow">Subagents ({subagents.length})</h4>
                    {/* Shown as work in its own right. A subagent's context is
                    discarded when it stops, so these files would otherwise
                    appear in the blast radius with nothing accounting for them. */}
                    <ul className="flex flex-col gap-3 t-small">
                      {subagents.map((agent) => (
                        <li key={agent.agentId} className="border-l-2 border-info/40 pl-2">
                          <div className="text-ink">
                            {agent.agentType ?? 'subagent'}
                            <span className="ml-1.5 text-dim">
                              {agent.toolCalls} tool call(s)
                              {/* Absent rather than estimated: most subagents have
                              no start event, and a duration derived from the
                              first tool call would look measured and be
                              guessed. */}
                              {agent.durationMs === null
                                ? ''
                                : ` · ${(agent.durationMs / 1000).toFixed(1)}s`}
                              {agent.finished ? '' : ' · running'}
                            </span>
                          </div>
                          {agent.files.length === 0 ? null : (
                            <div className="text-dim">{agent.files.join(', ')}</div>
                          )}
                          {agent.result === null ? null : (
                            <div className="mt-0.5 whitespace-pre-wrap text-dim">
                              {agent.result}
                            </div>
                          )}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {/* The close-out. Everything the operator needs in order to decide
                is above; this is the decision, named rather than implied. */}
                <div className="section">
                  <h4 className="mb-1 eyebrow">Review and close</h4>

                  {detail.card.mergedAt !== null ? (
                    <p className="mb-2 t-small text-ok">
                      Merged into {detail.card.mergedInto ?? 'the target branch'} from{' '}
                      {detail.card.mergedBranch ?? 'its branch'} on{' '}
                      {new Date(detail.card.mergedAt).toLocaleString()}.
                    </p>
                  ) : detail.workspace === null ? (
                    <p className="t-small text-dim">
                      No worktree, and the board has not merged this card. If it is finished, the
                      work reached the target some other way.
                    </p>
                  ) : (
                    <div className="mb-2 t-small">
                      <div className="text-ink">{detail.workspace.branch}</div>
                      <div className="text-dim">{detail.workspace.worktree}</div>
                      {detail.workspace.git === null ? null : (
                        <div
                          className={detail.workspace.git.dirty > 0 ? 'text-danger' : 'text-dim'}
                        >
                          {detail.workspace.git.ahead} commit(s) ahead
                          {detail.workspace.git.dirty > 0
                            ? `, ${detail.workspace.git.dirty} uncommitted change(s) - these would not be merged`
                            : ', working tree clean'}
                        </div>
                      )}
                    </div>
                  )}

                  <div className="flex flex-wrap gap-2">
                    {detail.workspace === null ||
                    detail.card.mergedAt !== null ? null : conflicted ? (
                      /* A conflict is the ordinary cost of two agents working in
                     parallel, not an exceptional event, so the action becomes
                     doing the work rather than reporting that it is needed. */
                      <button
                        type="button"
                        className="rounded border border-brand/60 px-2 py-0.5 t-small text-brand hover:bg-brand/10 disabled:opacity-40"
                        disabled={merging}
                        title={
                          'Resolves the conflict, commits the merge, and runs the verify command. ' +
                          'Judged from git afterwards, not from what the resolver says about itself.'
                        }
                        onClick={resolveThisConflict}
                      >
                        {merging ? 'resolving…' : 'solve conflicts and merge'}
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="rounded border border-ok/50 px-2 py-0.5 t-small text-ok hover:bg-ok/10 disabled:opacity-40"
                        // Disabled rather than left to fail. The gate refuses this
                        // request anyway, and a button that looks available and
                        // answers 409 teaches the operator that the board is
                        // unreliable rather than that something needs reading.
                        disabled={merging || outstanding > 0}
                        title={
                          outstanding > 0
                            ? `${String(outstanding)} thing(s) on this card have not been read yet. ` +
                              'Accept or reject each below and this becomes available. ' +
                              'A `git merge` run in a terminal is not prevented by this.'
                            : detail.verifyCommand === null
                              ? 'Merges without running anything afterwards: this card has no verify command.'
                              : `Merges, then runs ${detail.verifyCommand}. Stops and leaves the conflict in place if it does not pass.`
                        }
                        onClick={mergeThisCard}
                      >
                        {merging
                          ? 'merging…'
                          : outstanding > 0
                            ? `merge blocked - ${String(outstanding)} to read`
                            : `merge into ${detail.mergeTarget ?? 'the current branch'}`}
                      </button>
                    )}

                    {/* The way out of the block, because the block is not on
                        this pane. What is unread, and the accept and reject
                        controls that clear it, are findings and so live on the
                        brief - which leaves a disabled button here with its
                        reason one tab away. A disabled button whose reason
                        cannot be seen is the wall this gate was built not to
                        be, so it carries the route to the reason. */}
                    {outstanding === 0 ? null : (
                      <button
                        type="button"
                        className="rounded-md px-2 py-1 t-small text-brand underline-offset-2 hover:underline"
                        title="The unread findings, and the accept and reject controls, are on the brief."
                        onClick={() => setActivePane('brief')}
                      >
                        read them
                      </button>
                    )}

                    <button
                      type="button"
                      className="inline-flex items-center gap-1.5 rounded-md border border-edge px-2.5 py-1 t-small text-dim transition-colors hover:bg-well hover:text-ink"
                      title="Marks the card finished without merging anything. Use when the work landed another way, or was not needed."
                      onClick={() => patch({ status: 'done' })}
                    >
                      Mark done
                    </button>

                    {detail.card.status === 'idle' ? null : (
                      <button
                        type="button"
                        className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 t-small text-dim transition-colors hover:bg-well hover:text-ink"
                        title="Back to idle, which is the only status the queue will dispatch."
                        onClick={() => patch({ status: 'idle' })}
                      >
                        reopen
                      </button>
                    )}
                  </div>

                  {mergeReport === null ? null : (
                    <pre
                      className={`mt-2 max-h-40 overflow-y-auto whitespace-pre-wrap font-mono t-fine ${
                        mergeReport.clean ? 'text-ok' : 'text-danger'
                      }`}
                    >
                      {mergeReport.summary.join('\n')}
                    </pre>
                  )}

                  {resolution === null ? null : (
                    <p className="mt-2 t-fine leading-snug text-dim">{resolution}</p>
                  )}
                </div>
              </SectionFlow>
            )}
          </>
        </Rail>
      </div>

      {timelineRunId === null ? null : (
        <Timeline runId={timelineRunId} onClose={() => setTimelineRunId(null)} />
      )}
    </div>
  );
}
