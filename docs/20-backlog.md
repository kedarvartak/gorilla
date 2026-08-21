# 20 - Backlog

The working list. Doc 10 is the roadmap and does not change; doc 19 records what
exists. This file is the queue between them: what is worth building next, why, and
what would have to be true to call it done.

Every entry is scoped so that one agent can finish it in one pull request, with
tests, and without anyone having to try it by hand to know whether it worked. Items
that need a real-world trial belong in doc 19's "what has never happened" list
instead, and are deliberately absent here.

Status values: `open`, `in progress`, `merged`, `dropped`. The identifier is stable
once assigned; a dropped item keeps its number rather than being reused.

## How this list was chosen

Three sources, in order of weight.

1. **Gaps the code already admits to.** Doc 19's "what is not built", plus places
   where two facts are each checked against a constant and never against each other -
   the failure that produced the hook-target mismatch (G8) and the stale-bundle
   confusion after G10.
2. **What the loop costs to operate.** Anything that currently requires leaving the
   board for a terminal is a seam where the operator loses the context the board
   exists to hold.
3. **What comparable orchestrators treat as table stakes.** Parallel attempts,
   task templates, cost ceilings, mid-run steering, checkpointing, issue import,
   and a metrics view are common to the category and absent here. They are listed
   where they fit Gorilla's model, not copied wholesale: this board's premise is that
   the operator stays in sync with the work, so features that hide the work from the
   operator are excluded even where competitors ship them.

---

## A. Contracts and integrity

Two facts that must agree, currently agreeing only by luck.

| Id | Task | Done when |
| --- | --- | --- |
| T1 | Build handshake between server and interface | The server exposes its build id; the UI refuses to run against a mismatched one and says so, rather than calling routes that 404. |
| T2 | Refuse to serve a stale bundle | `src/server/web/routes.ts` serves the built UI only when its manifest matches the running server, and reports the mismatch otherwise. |
| T3 | Route contract tests | Every route in the API has a test asserting its response shape, so a shape change breaks a test rather than a screen. |
| T4 | Reject unknown fields on card update | `PATCH /api/cards/:cardId` returns 400 for a field it does not know, instead of accepting and dropping it. |
| T5 | Migration ladder test | Every migration applies to an empty database and to the previous version's database, asserted in CI. |
| T6 | Schema drift check | CI fails when the Drizzle schema and the applied migrations disagree. |
| T7 | Dispatch idempotency constraint | A card cannot be in flight twice, enforced by the database rather than by call order. |
| T8 | Typed error bodies | One helper produces every 400/404/409 body, with a discriminated type the interface can switch on. |

## B. Structure

Work that buys nothing on its own and makes the next ten items cheaper.

| Id | Task | Done when |
| --- | --- | --- |
| T9 | Split the route module | `routes.ts` becomes one module per resource, behaviour identical, existing tests unchanged. |
| T10 | Extract a card service layer | Route handlers call named operations rather than composing queries inline, so the same operation is reachable from the CLI. |
| T11 | Single event-payload parser | One place decodes a hook payload and reports what it could not read, replacing the per-caller casts. |
| T12 | Shared fetch client for the interface | The web app's requests go through one typed client that surfaces non-2xx as errors rather than as parsed bodies. |

## C. The project model

Doc 12's remaining half. Nothing currently proposes a rule from what the runs
established; both promotion paths are manual.

| Id | Task | Done when |
| --- | --- | --- |
| T13 | Subsystem map | Each card records which paths its run actually touched, derived from tool events. |
| T14 | Propose a card guardrail | Accepted ledger entries yield a proposed guardrail the operator accepts or drops; nothing is applied silently. |
| T15 | Propose a board invariant | A rule appearing on three or more cards is offered as a project rule. |
| T16 | Contradiction check on a new card | A card whose text conflicts with a standing invariant is flagged before dispatch. |
| T17 | Retirement candidates | An invariant no run has exercised across N cards is surfaced as removable. |
| T18 | Blast radius from history | A card's likely blast radius is proposed from the subsystem map of prior cards touching the same paths. |
| T19 | Related cards | A card links to earlier cards that touched the same subsystem, so an agent inherits the prior finding. |

## D. Operating the loop

Everything here currently requires a terminal.

| Id | Task | Done when |
| --- | --- | --- |
| T20 | Cancel a running card from the board | The interface reaches `launcher.cancel()`, and the card lands in a state that says cancelled rather than failed. |
| T21 | Retry in place | A failed card retries against its existing worktree instead of re-dispatching from scratch. |
| T22 | Requeue with a correction | Retry carries an operator note into the next run's context. |
| T23 | Pause and resume the queue | The dispatcher can be held without being torn down, and says why it is holding. |
| T24 | Reorder the dispatch queue | Queue order is editable from the board, not only implied by column position. |
| T25 | Concurrency control per board | The number of simultaneous runs is a board setting with a tested upper bound. |
| T26 | Per-card cost ceiling | A run that exceeds its token ceiling halts and reports, rather than running until it finishes. |
| T27 | Board-level daily budget | The queue stops dispatching when the day's budget is spent, and says so on the board. |

## E. What a card shows

| Id | Task | Done when |
| --- | --- | --- |
| T28 | Verify output on failure | The verify command's captured output is shown, not only its exit code. |
| T29 | Token and duration accounting | Each card shows what its runs cost, from the run events. |
| T30 | Branch diff summary | Files, insertions and deletions appear in the card, so review does not require a terminal. |
| T31 | Full diff view | The branch's diff is readable in the card, per file. |
| T32 | Run timeline density | The timeline distinguishes thinking, tool use, and waiting, rather than showing one undifferentiated run. |
| T33 | Error grouping | Repeated identical errors within a run collapse into one entry with a count. |
| T34 | Card search | Cards are searchable by title, body and touched path. |

## F. Review and merge

| Id | Task | Done when |
| --- | --- | --- |
| T35 | Merge queue | Several ready cards merge in a defined order, each verified after the previous, with a single report. |
| T36 | Pre-merge second opinion | A fresh agent reviews the branch and its findings enter the ledger as surprises before the gate opens. |
| T37 | Review checklist from the ledger | The gate shows what was established during the run, so accepting is an informed act. |
| T38 | Follow-up card from a rejected entry | Rejecting a ledger entry can create the card that addresses it, linked to its origin. |
| T39 | Merge dry run | The board reports whether a branch would conflict, before the operator commits to merging. |
| T40 | Post-merge verification | The verify command runs once more on the merged result, and the card records that it did. |

## G. Autonomy

The point of the product: work that continues correctly while nobody is watching.

| Id | Task | Done when |
| --- | --- | --- |
| T41 | Scheduled dispatch window | A board can be told to work only between given hours. |
| T42 | Automatic retry policy | A run that fails for a transient reason retries under a stated policy; one that fails for a stated reason does not. |
| T43 | Escalation ladder | Repeated failure on one card stops that card rather than the queue, and marks it for the operator. |
| T44 | Health check endpoint | One endpoint reports queue depth, in-flight runs, halt state and last event time. |
| T45 | Webhook on state change | Card state changes can be posted to a configured endpoint, with the same no-interpolation discipline as `GORILLA_NOTIFY`. |
| T46 | Checkpoint a long run | A run's progress is recorded at intervals so a killed process resumes rather than restarts. |
| T47 | Restart recovery for in-flight runs | A server restart reconciles running cards against live processes instead of leaving them in progress forever. |
| T48 | Orphan worktree reaper | Worktrees with no card are removed on a schedule, with a report of what was removed. |

## H. Intake

| Id | Task | Done when |
| --- | --- | --- |
| T49 | Card templates | A card can be created from a named template carrying its guardrails and verify command. |
| T50 | Import GitHub issues as cards | Issues become cards with their origin recorded, without polling anything on a timer by default. |
| T51 | Bulk card creation from a file | A markdown list becomes cards in one operation, with a dry run. |
| T52 | Card splitting | A card too large to dispatch can be split into dependent cards, preserving its context. |
| T53 | Duplicate card detection | A new card that restates an existing one is flagged at creation. |

## I. Command line and export

| Id | Task | Done when |
| --- | --- | --- |
| T54 | `gorilla export` | The whole board state renders to one reviewable markdown file. |
| T55 | `gorilla status` | Queue state, in-flight runs and halt state, without opening the interface. |
| T56 | `gorilla dispatch` | A card is dispatched from the command line, reusing the service layer rather than the HTTP route. |
| T57 | `gorilla verify` | The verify command runs against a card's branch from the terminal, reporting as the board would. |
| T58 | Machine-readable output | Every command takes `--json`, so the board is scriptable. |

## J. Metrics

| Id | Task | Done when |
| --- | --- | --- |
| T59 | Throughput and lead time | The board reports cards completed, time from ready to merged, and where time is spent. |
| T60 | Failure taxonomy | Failures are classified by cause and counted, so the common failure is visible rather than remembered. |

---

## Order

The dependencies are real and worth respecting.

- T9 before anything in sections C through G that adds a route, because a
  1600-line module is where parallel cards collide.
- T13 before T14, T15, T18 and T19: they all read the subsystem map.
- T20 before T21 and T22, which need a cancelled state to return from.
- T29 before T26 and T27, which need accounting before they can enforce a ceiling.
- T3 and T12 early: a contract test and a typed client turn later shape changes
  into failing tests rather than into broken screens.

Everything else is independent and can be taken in any order.
