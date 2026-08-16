# 05 - Concepts and Data Model

## Entity overview

```
Board  1---*  Card  1---*  Run  1---*  Event
                |            |
                |            *---1  Session (Claude Code session_id)
                |
                *---*  LedgerEntry  (decision | assumption | change | risk | question)
                *---1  Brief        (synthesised, regenerated)
                *---*  Acknowledgement
```

## Board

A board is bound to exactly one repository working directory. The `cwd` field in every
hook payload is what routes an incoming event to a board, so this binding must be
exact and canonicalised (symlinks resolved). Boards own their column configuration and
their gate policy.

A single Gorilla instance serves several boards; the operator has several projects.

## Card

The atomic unit of work and the atomic unit of comprehension. A card is not a ticket -
it is a container for everything known about one strand of work.

Fields:

- `id`, `title`, `body` (operator-authored intent, markdown)
- `column` and `position`
- `goalCondition` - the text passed to `/goal`, authored with assistance (doc 08)
- `guardrails` - see below. Injected into every run on this card
- `agentModel`, `agentEffort`, `permissionMode` - how this card is executed
- `synthesisModel` - which model summarises this card's events
- `dependsOn` - other cards that must reach the terminal column first
- `status` - `idle`, `queued`, `running`, `awaiting-review`, `blocked`, `done`, `abandoned`
- `lastSeenAt` - the timestamp at which the operator last opened the card. This single
  field powers the "what changed since you looked" digest, which is the product's most
  direct answer to the problem in doc 01
- `acknowledgedAt` - set when the operator passes the gate

### Guardrails

The constraints a card's agent must obey, defined by the operator before dispatch and
enforced by three different mechanisms depending on the kind of rule. Distinguishing
them matters, because only some are actually enforceable:

| Kind | Example | Mechanism | Enforcement |
| --- | --- | --- | --- |
| Scope | "only touch `src/ingest/`" | Rendered into the appended system prompt | Instructional |
| Prohibition | "do not modify the schema, do not add dependencies" | Prompt, plus a `PreToolUse` deny rule where the target is expressible as a path or command pattern | Hard where expressible |
| Permission | "may edit files, may not run network commands" | `--permission-mode` and `--allowedTools` at launch | Hard |
| Verification | "the build must pass before you claim completion" | Folded into the goal condition, and re-checked by the board's verify gate | Hard at the gate |
| Budget | "stop after 20 turns" | Appended to the goal condition; the evaluator judges it | Soft |

The board tells the operator which of their guardrails are hard and which are merely
requests, because a guardrail believed to be enforced but which is not is worse than
no guardrail at all.

This is the one place the design admits `PreToolUse` blocking despite P2, and the
distinction holds: a rule the operator wrote in advance is not an interruption, because
nobody is waiting on it. Denials are recorded as ledger risk entries so the operator
learns which guardrails the agent kept pushing against.

Guardrails can be defined per card or per board, with card-level rules adding to
board-level ones rather than replacing them.

### Per-card model selection

Two independent choices, both defaulting to board settings and both overridable per
card:

- **`agentModel` and `agentEffort`** - the model that does the work. A mechanical
  refactor across forty files and a subtle concurrency fix do not warrant the same
  model, and the operator knows which is which at planning time.
- **`synthesisModel`** - the model that writes the ledger and brief for this card. A
  high-stakes architectural card justifies expensive synthesis; a dependency bump does
  not.

Both are set during planning and are visible on the card, alongside that card's
accumulated spend, so the cost of a choice is legible at the point the choice is made.

### Columns

Default column set, chosen to mirror the ACE-FCA research/plan/implement loop rather
than a generic Todo/Doing/Done:

| Column | Meaning |
| --- | --- |
| Intake | Captured, not yet specified |
| Ready | Has a goal condition, guardrails, and a model; eligible for dispatch |
| Running | A session is bound and active |
| Needs Review | Agent believes it is complete; gate is holding it here |
| Done | Operator acknowledged the brief |

Columns are configurable, but exactly one column must be designated the review gate
and exactly one the terminal column, because the gate logic depends on knowing which.

## Plan

A planning session is the normal way cards come into existence. The operator and Claude
decompose a piece of work in an ordinary Claude Code conversation; at the end, the
session writes the resulting cards onto the board in one call.

A Plan records that batch: `boardId`, `sourceSessionId`, `createdAt`, `prompt`, and the
cards it produced. Keeping the provenance matters for the same reason the ledger keeps
`sourceEventIds` - when a card's intent is unclear three weeks later, the conversation
that produced it is the answer, and it is one link away.

Cards arriving from a plan land in Intake or Ready depending on whether they carry a
goal condition. The board never silently dispatches a card a plan created; promotion to
Ready is an operator action, because the planning conversation is exactly the kind of
context that feels complete at the time and turns out not to be.

## Dispatcher

Decides which Ready card starts next. Deliberately simple:

- **Serial by default.** One running card per board. This follows from P1 - two agents
  running at once doubles what the operator must resynchronise with, which is the cost
  the product exists to reduce. Concurrency is a per-board setting with a low default,
  not an architectural assumption.
- **Dependency-aware.** A card with unsatisfied `dependsOn` is not eligible.
- **Manual or automatic.** Automatic dispatch pulls the top eligible Ready card when the
  board goes idle. Manual requires the operator to start each one. Automatic is what
  makes an evening's queue run unattended; manual is the safer default until the
  operator trusts their own guardrails.
- **Halt on trouble.** Automatic dispatch stops when a card fails, hits a gate, or
  raises a question. It does not work through a queue while an earlier card sits
  unreviewed, because an unreviewed card is an unvalidated assumption that later cards
  may be building on.

## Run

One card may be worked on several times - a first attempt, a follow-up after review,
a resumed session the next morning. A Run is one binding of one card to one Claude
Code session.

Fields: `cardId`, `sessionId`, `mode` (`attached` or `launched`), `startedAt`,
`endedAt`, `endReason`, `model`, `permissionMode`, `goalOutcome`
(`met` / `impossible` / `cleared` / `abandoned`), `transcriptPath`, `gitBranch`,
`headShaAtStart`, `headShaAtEnd`.

Separating Run from Card is what makes the card's history legible across days and
across compactions. The card is the durable thing; runs come and go.

## Session binding

The hard problem. An event arrives carrying `session_id` and `cwd`. Which card does it
belong to?

Three mechanisms, in precedence order:

1. **Launched binding.** The board started the session, so it knows the mapping. When
   the board spawns `claude -p`, it sets `GORILLA_CARD_ID` in the environment and reads
   `session_id` from the `system/init` event. Authoritative.
2. **Declared binding.** The operator runs `/gorilla:claim <card>` in their own
   session, or the board's `SessionStart` hook responds with a claim prompt. The board
   writes the mapping.
3. **Inferred binding.** An unbound session appears in a board's `cwd`. The board
   creates a provisional card titled from the session's `ai-title` or first user
   prompt, and marks it `inferred`. The operator can merge it into an existing card.

Inference exists because of P2 and the non-goal of replacing the terminal: work that
starts in the terminal without ceremony must still be captured. An unclaimed session
producing no card would be the exact blind spot the product exists to remove.

## Event

The raw, append-only record. One row per hook delivery.

Fields: `runId`, `sessionId`, `seq`, `eventName`, `receivedAt`, `payload` (JSON),
`toolName`, `toolUseId`, `promptId`, `agentId`.

Events are never edited and never deleted by the application. They are the audit trail
that every synthesised artifact can be traced back to. Retention is time- or
size-bounded per board, with the ledger and briefs explicitly exempt - the raw stream
is disposable, the synthesis is not.

## LedgerEntry

The centre of the product. A single durable, typed, human-readable statement about the
work. Types:

| Type | Definition | Typical trigger |
| --- | --- | --- |
| `decision` | A choice made between alternatives, with the alternative and rationale | Assistant text at a turn boundary; pre-compaction sweep |
| `assumption` | Something taken as true without verification | Explicit hedging in assistant output |
| `change` | A material modification to the repository | `PostToolUse` on Edit/Write/NotebookEdit, aggregated |
| `risk` | Something that may fail later | Failed tool calls, retries, skipped tests |
| `question` | Something requiring human judgement | Blocked work, `AskUserQuestion`, ambiguity |

Fields: `cardId`, `runId`, `type`, `statement` (one sentence), `detail` (markdown),
`sourceEventIds`, `filePaths`, `confidence`, `createdAt`, `supersededBy`,
`operatorStatus` (`unreviewed` / `accepted` / `rejected` / `corrected`).

Three properties matter:

- **Traceability.** `sourceEventIds` means every synthesised claim can be expanded to
  the raw events that produced it. Nothing in the ledger is unfalsifiable.
- **Supersession, not deletion.** When a later decision reverses an earlier one, the
  earlier is marked superseded and retained. The history of reversals is often the
  most informative part of a long run.
- **Operator status.** The ledger is a two-way surface. Rejecting an assumption is a
  signal that can be injected back into the session (doc 07), which is the mechanism by
  which comprehension turns into correction.

## Brief

A regenerated, cached synthesis of a card's current state, structured for two-minute
reading. It is derived and disposable; the ledger is the source of truth. Full
specification in doc 08.

## Acknowledgement

A record that the operator read a specific brief version and released the gate.
Fields: `cardId`, `briefVersion`, `at`, `note`. Required for a card to leave the review
column when the gate is enabled.

## Storage

SQLite, one file per Gorilla installation, at `~/.gorilla/gorilla.db`. Rationale:
single-writer local workload, transactional integrity for the event stream,
zero-configuration, and full-text search available through FTS5 for free - which the
ledger needs.

Events are the high-volume table; payloads are stored as JSON text with generated
columns for the fields that are indexed. Ledger and brief tables are small.
