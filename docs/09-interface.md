# 09 - Interface Specification

## Design posture

A dense, quiet, information-first instrument. The reference points are Linear and a
monitoring console, not a consumer productivity app. Dark theme primary. No
illustrations, no animated celebrations, no empty-state whimsy. The operator opens this
tool at a moment of low context and mild anxiety; the interface should read as an
instrument panel that answers questions.

Typography carries the hierarchy: one sans family for the interface, one monospace for
paths, identifiers, and diffs. Colour is reserved for state and is never decorative,
because the whole colour budget is needed to distinguish six card states at a glance.

## Screen 1: Board

Columns as specified in doc 05. Each card shows, at rest:

- Title.
- A state indicator - idle, running (with elapsed time), needs review, blocked, done.
- A **context utilization ring** when a run is active, computed from transcript
  `usage`. Green through 60 percent, amber to 80, red above. The 40 to 60 percent target
  comes from the ACE-FCA guidance in doc 03; above 80 percent the operator should expect
  degraded agent reasoning and imminent compaction.
- An **unseen badge** counting ledger entries added since `lastSeenAt`. This is the
  board's primary call to action and should be the most visually prominent element on
  any card that has one.
- A compact blast-radius indicator: number of files touched this run.
- Icons for compaction events and unresolved questions.

The board header carries a global bar: sessions currently running, total unseen entries
across all cards, today's spend split between agent and synthesis, and any
degraded-surface warnings from doc 06.

It also carries the dispatcher control - manual or automatic, the concurrency limit, and
a single prominent stop that halts dispatch without killing the run in progress. When
automatic dispatch has halted itself on a failure or an unreviewed card (doc 05), the
header says so and names the card responsible, because a silently stopped queue looks
identical to an empty one.

Cards that arrived from a planning session are marked with their plan, and the plan links
back to the conversation that produced it.

Drag and drop moves cards between columns. A drag into the terminal column while a gate
is active is refused with an inline explanation and a link to the brief, rather than
silently reverting.

## Screen 2: Card detail

Three-pane layout on wide viewports, stacked below 1200 px.

**Left rail - specification.** Title, body, guardrails with their enforcement kind, the
selected agent and synthesis models, the composed goal condition
with the authoring warnings from doc 07 §4, and run history. Editable while the card is
idle; read-only with an override while a run is active.

**Centre - the brief.** The eight sections of doc 08 rendered in order, with the
"Since you last looked" section pinned at top and visually separated. Each ledger entry
is a row with its type, statement, confidence, source count, and the four operator
actions. Clicking a source count expands the underlying events inline.

This pane is the default landing view for a card. It is never the timeline.

**Right rail - live and evidence.** When a run is active: current turn, current tool,
elapsed time, token usage, goal verdict with the evaluator's latest reason. When idle:
the run history and the evidence tree.

## Screen 3: Timeline

Reached from the card, never the default. A chronological rendering of events for one
run, with:

- Subagent events nested and collapsible under the tool call that spawned them, using
  `agent_id` and `parent_tool_use_id`.
- Compaction rendered as a full-width discontinuity marker, labelled with the token
  count before compaction and the number of ledger entries preserved at that point.
  This marker is the visual anchor of the whole screen - the operator should be able to
  see at a glance how many times the agent's memory was reset.
- Filters by event type, tool, and file.
- Turn boundaries marked, with each turn collapsible to its one-line synthesis.

## Screen 4: Resync digest

A cross-card view reached from the header, answering one question: what happened across
this whole repository since I last looked at it.

Ordered by significance rather than time - decisions above changes, unresolved questions
above completed work. Each item links to its card. This is the screen for returning
after a long absence, when the operator does not yet know which card to open.

## Screen 5: Settings and diagnostics

Board configuration, gate policy per column, synthesis budget and model selection, event
retention, and the output of `gorilla doctor` rendered live: which hooks have fired
recently, which are silent, whether the transcript parser is reporting schema drift,
and current spend.

Diagnostics get a real screen rather than a log file because P7 requires the system to
announce what it cannot see, and a warning nobody can find is not an announcement.

## Notifications

Desktop notifications for exactly three events: a card enters Needs Review, a run fails
(`StopFailure`), and a session raises a `Notification` of type `permission_prompt` or
`idle_prompt` - meaning an autonomous run has stalled waiting for a human.

Nothing else notifies. Notification volume is the fastest way to recreate the interrupt
problem this product exists to solve (P2).

## Keyboard

Full keyboard operation of the board: navigation between cards and columns, open, move,
acknowledge, and a command palette. Drag and drop via `@dnd-kit` keyboard sensors, which
is the main reason for that library choice.

## Export

Any card exports as a single markdown document containing the brief, the full ledger,
and the run history, suitable for committing to the repository as a decision record
(P8). Board-level export produces one file per card plus an index.
