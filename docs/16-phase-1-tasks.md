# 16 - Phase 1 Task Plan

Twelve tasks covering Phase 1 (doc 10): plan, dispatch, observe. Written in the
card shape from doc 05, as doc 13 was, so this plan can seed the board once the
board exists - which happens inside this phase.

**Phase 1 contains no synthesis.** No model calls, no ledger extraction, no
brief. The ledger here is mechanical only: file changes, failures, goal verdicts,
git reality, and unresolved tool intents. That is deliberate. If the mechanical
ledger alone is not worth reading, the model layer in Phase 2 will not save it,
and it is far cheaper to discover that now.

## What Phase 0 established that this phase builds on

- Hook ingest, storage, ordering, and the fixture harness all work (doc 15).
- `SessionStart` must be bridged; every other event arrives over HTTP.
- A denied tool call is invisible except as an intent with no outcome.
- `PreCompact` exposes a readable transcript tail, and `SessionStart
  source=compact` fires - so compaction repair is viable, but it is Phase 3
  work because it needs operator-accepted entries to draw on.

## Dependency graph

```
P1  cards schema ──┬─► P2  board API ──┬─► P3  board UI ──┬─► P4  card detail
                   │                   │                  └─► P9  timeline
                   │                   ├─► P5  goal authoring
                   │                   └─► P6  plan intake
                   ├─► P7  launcher ───┬─► P8  dispatcher
                   │                   └─► P10 binding
                   └─► P11 mechanical ledger
                                        └─► P12 phase-1 verification
```

---

## P1. Cards, guardrails and the plan schema

**Body.** Extend the doc 05 model: `cards` (title, body, column, position,
status, goal condition, guardrails, `agentModel`, `agentEffort`,
`permissionMode`, `synthesisModel`, `dependsOn`, `lastSeenAt`,
`acknowledgedAt`), `plans`, `columns` per board, and `runs.card_id` becoming a
real foreign key. Guardrails stored as structured JSON with the doc 05 taxonomy -
scope, prohibition, permission, verification, budget - not as free text, because
the enforcement kind has to survive the round trip.

**Goal condition.** A migration applied to a temporary database creates every
table and constraint, and a test proves a card cannot enter the terminal column
while an unsatisfied `dependsOn` exists, with the output shown. No existing
Phase 0 data is lost by the migration, proven by migrating a seeded database.

**Guardrails.** Scope: `src/server/db/`. Prohibit: destructive migrations - the
Phase 0 event history must survive; ledger or brief tables beyond a placeholder.

**Model.** Sonnet. **Depends on.** Nothing.

---

## P2. Board and card API

**Body.** REST for boards, columns, cards and plans: create, read, update, move,
delete. Position management for drag and drop that does not renumber the whole
column on every move. SSE events published on every mutation so the interface
stays live. Validation returns per-field errors rather than a 400 with no detail.

**Goal condition.** A test exercising create, move within a column, move across
columns, and delete leaves the database consistent and emits the matching SSE
events, with output shown. Concurrent moves of two cards do not corrupt ordering.

**Guardrails.** Scope: `src/server/api/`. Prohibit: any work on the hook path;
authentication (non-goal).

**Model.** Sonnet. **Depends on.** P1.

---

## P3. The board interface

**Body.** React and Vite replacing the Phase 0 HTML page. Columns, cards, drag
and drop with `@dnd-kit` including keyboard sensors, the doc 09 header bar
(running sessions, unseen count, spend placeholder, degraded-surface warnings),
and live updates over SSE. Dark, dense, instrument-like per doc 09 - no
illustrations, colour reserved for state.

**Goal condition.** With the server running, a card can be created, dragged
between columns and reordered using only the keyboard, and a second browser tab
reflects every change within a second. Confirmed with output or screenshots.

**Guardrails.** Scope: `src/web/`. Prohibit: a component library that imposes its
own design language; any state manager beyond React state and SSE.

**Model.** Sonnet. **Depends on.** P2.

---

## P4. Card detail

**Body.** The three-pane layout from doc 09: specification rail (title, body,
guardrails with their enforcement kind visible, models, composed goal condition,
run history), centre pane, and the live rail (current turn, tool, elapsed,
tokens, goal verdict). No brief yet - the centre pane shows the mechanical
ledger from P11.

**Goal condition.** Opening a card with a completed run shows every guardrail
labelled hard or advisory, both model selections, and the run history, with no
placeholder text left in the interface. Verified against a real run.

**Guardrails.** Scope: `src/web/`. Prohibit: presenting an advisory guardrail as
if it were enforced (R10) - the enforcement kind is not optional decoration.

**Model.** Sonnet. **Depends on.** P3.

---

## P5. Goal authoring

**Body.** Compose the `/goal` condition from card fields in the doc 07 section 4
structure, with the warnings: no verifiable check, over 4,000 characters, no turn
or time bound. Live preview of the exact string that will be passed.

**Goal condition.** Tests covering each warning pass with output shown, and a
composed condition for a real card is under 4,000 characters and contains a
stated check whose output would appear in the conversation.

**Guardrails.** Scope: `src/server/goal/`, `src/web/`. Prohibit: silently
rewriting what the operator typed - warn, never correct.

**Model.** Sonnet. Small, but the evaluator's tool-blindness is
counter-intuitive and most `/goal` disappointments trace to it.

**Depends on.** P2.

---

## P6. Plan intake

**Body.** The `/gorilla:plan` slash command written by `init`, and
`POST /api/boards/:board/plans`. The command's instructions carry the goal
authoring rules and the guardrail taxonomy so the planning agent produces
conditions the evaluator can assess. The endpoint validates each card and returns
per-card warnings for Claude to report back in the conversation. Cards land
unstarted; promotion is an operator action.

**Goal condition.** A real planning conversation produces at least four cards on
the board with goal conditions and guardrails, and at least one validation
warning is surfaced back into that conversation and fixed there. Output shown.

**Guardrails.** Scope: `src/server/api/`, `src/cli/`. Prohibit: auto-promoting
planned cards to Ready, or dispatching anything on intake.

**Model.** Sonnet. **Depends on.** P2, P5.

---

## P7. The launcher

**Body.** Spawn and supervise `claude -p` per doc 07 section 3: goal condition,
`--model`, `--permission-mode`, `--allowedTools` derived from guardrails,
`--append-system-prompt-file` with a generated `card-context.md`, and a
`--settings` overlay carrying guardrail-derived `PreToolUse` deny rules. Consume
`stream-json`, correlate the session id from `system/init`, surface
`system/api_retry`, and cancel with SIGTERM.

**Goal condition.** A card dispatched from the board runs to completion
unattended, its session is bound from `system/init` without inference, a
guardrail-derived deny rule is shown blocking a prohibited path, and cancelling
mid-run terminates the child and records the run as abandoned. All four shown.

**Guardrails.** Scope: `src/server/launcher/`. Prohibit: writing guardrail deny
rules into the project's settings file - they are passed at launch so they apply
to one card's session only; leaving orphaned child processes on board shutdown.

**Model.** Opus. Process supervision, signal handling and a security-relevant
overlay, where a subtle mistake is a card's restrictions silently not applying.

**Depends on.** P1.

---

## P8. The dispatcher

**Body.** Serial by default, dependency-aware, manual or automatic, and halting
on failure, gate or question rather than working through the queue (doc 05).
Concurrency is a per-board setting with a low default.

**Goal condition.** Six Ready cards with one dependency chain dispatch in a legal
order, one at a time; a deliberate failure halts the queue with the responsible
card named; and the header states plainly that dispatch has stopped. Shown.

**Guardrails.** Scope: `src/server/dispatch/`. Prohibit: dispatching a card whose
dependencies are unmet, or continuing past an unreviewed failure - a silently
stopped queue must be distinguishable from an empty one.

**Model.** Sonnet. **Depends on.** P7.

---

## P9. The timeline

**Body.** Per-run chronological view: subagent events nested under the spawning
tool call by `agent_id`, compaction rendered as a full-width discontinuity marker
with the pre-compaction token count, filters by event type and tool, and turn
boundaries. Reached from the card, never the default view (P3 of doc 04).

**Goal condition.** A run containing a subagent and a compaction renders with the
subagent nested and the compaction marked, and the operator can filter to a
single tool. Verified against a recorded fixture so it is reproducible.

**Guardrails.** Scope: `src/web/`. Prohibit: making the timeline a card's landing
view; loading an entire run's events at once for a long session.

**Model.** Sonnet. **Depends on.** P3.

---

## P10. Attached-mode binding

**Body.** The secondary path that keeps terminal sessions from becoming a blind
spot: `/gorilla:claim <card>`, `SessionStart` responding with the board's
`additionalContext` and open cards, and provisional inferred cards for unclaimed
sessions, titled from the transcript's `ai-title` or first prompt. Merging an
inferred card into an existing one.

**Goal condition.** A session started by hand in the terminal produces a
provisional card without any operator action, `/gorilla:claim` binds an existing
card, and merging a provisional card preserves its events. All three shown.

**Guardrails.** Scope: `src/server/binding/`, `src/cli/`. Prohibit: dropping
events for an unclaimed session - an event with nowhere to go is the blind spot
the product exists to remove.

**Model.** Sonnet. **Depends on.** P7.

---

## P11. The mechanical ledger

**Body.** Deterministic entries only, no model calls: change entries from
`PostToolUse` on Edit/Write/NotebookEdit aggregated per file; risk entries from
`PostToolUseFailure`, `StopFailure` and unresolved tool intents; change entries
from Bash calls matching install, migration or schema patterns; goal verdicts and
the evaluator's stated reason from the transcript; git reality at run end against
`headShaAtStart`; and the claim-versus-reality check - files discussed but not
changed, and files changed but never mentioned.

**Goal condition.** For a completed real run, the ledger names every file git
reports as changed, flags at least one claim-versus-reality discrepancy or
states there were none, and reports the goal verdict with the evaluator's reason.
Output shown, every entry traceable to the events it came from.

**Guardrails.** Scope: `src/server/ledger/`. Prohibit: any model call or API key
use in this phase; any entry that cannot name its source events.

**Model.** Sonnet. **Depends on.** P1.

---

## P12. Phase 1 verification

**Body.** The doc 10 exit gate. Plan a real conversation, land six cards with
guardrails and models, dispatch them, let them run unattended, and report on
attribution, guardrail denials recorded, mechanical ledger accuracy, and whether
the loop was pleasant enough to use again. Also close the Phase 0 items doc 15
left open: automatic compaction observed, the six unexercised hooks, and long-run
behaviour over an hour.

**Note.** Human-supervised, like T10. The judgement of whether the mechanical
ledger is worth reading is the operator's, and it is the gate.

**Goal condition.** A verification report exists covering all of the above, based
on a real sitting of at least an hour, ending in an explicit pass or fail against
doc 10's Phase 1 gate and a recommendation on whether Phase 2 should begin.

**Guardrails.** Scope: `docs/`, `test/`. Prohibit: fabricating or extrapolating
any measurement; declaring the gate passed on the strength of the tooling working
rather than the ledger being useful.

**Model.** Opus. **Depends on.** P8, P9, P10, P11.

---

## Sequencing rationale

P1, P2 and P7 are the spine and can start immediately. The interface tasks
(P3, P4, P9) depend on the API but not on each other beyond P3. P11 is
independent of everything except the schema, so it can proceed in parallel with
the interface work - and it is the task the gate actually turns on.

The riskiest assumption in this phase is **not** whether the board can dispatch a
session; Phase 0 proved every mechanism that requires. It is whether a
deterministic ledger, with no synthesis at all, already tells the operator
something worth knowing. P11 and P12 exist to answer that, and everything else
exists to give them realistic material.

If the answer is no, Phase 2 should be re-planned rather than started.
