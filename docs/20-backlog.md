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

| Id | Task | Done when | Status |
| --- | --- | --- | --- |
| T1 | Build handshake between server and interface | The server compares when the interface was built against when it was built itself, and the board says so. Reports rather than refuses: see the note below. | merged |
| T2 | Refuse to serve a stale bundle | ~~Rescoped: reports rather than refuses.~~ Folded into T1. | merged |
| T3 | Route contract tests | The routes the interface depends on have shape assertions, and the route count is a tripwire for the rest. | merged |
| T4 | Reject unknown fields on card update | `PATCH /api/cards/:cardId` returns 400 for a field it does not know, instead of accepting and dropping it. | merged |
| T5 | Migration ladder test | Every migration applies to an empty database and to the previous version's database, asserted in CI. | merged |
| T6 | Schema drift check | CI fails when the Drizzle schema and the applied migrations disagree. | merged |
| T7 | Dispatch idempotency constraint | A card cannot be in flight twice, enforced by the database rather than by call order. | merged |
| T8 | Typed error bodies | One helper produces every 400/404/409 body, with a discriminated code the interface can switch on. | merged |

## B. Structure

Work that buys nothing on its own and makes the next ten items cheaper.

| Id | Task | Done when | Status |
| --- | --- | --- | --- |
| T9 | Split the route module | `routes.ts` becomes one module per resource, behaviour identical, existing tests unchanged. | merged |
| T10 | Extract a card service layer | ~~Withdrawn: the stated reason does not hold.~~ See the rescope below. | dropped |
| T11 | Single event-payload parser | ~~Mostly built: `src/server/json.ts` already was it.~~ One caller bypassed it and now does not. | merged |
| T12 | Shared fetch client for the interface | Every component request goes through one typed client. No component calls `fetch` any more. | merged |

## C. The project model

Doc 12's remaining half. Nothing currently proposes a rule from what the runs
established; both promotion paths are manual.

| Id | Task | Done when | Status |
| --- | --- | --- | --- |
| T13 | Subsystem map | Each card records which paths its run actually touched, from git and from the run's own account, kept apart. | merged |
| T14 | Propose a card guardrail | Accepted ledger entries yield a proposed guardrail the operator accepts or drops; nothing is applied silently. | merged |
| T15 | Propose a board invariant | A rule appearing on three or more cards is offered as a project rule. | merged |
| T16 | Contradiction check on a new card | ~~Narrowed.~~ A card whose *scope* names a path a project rule prohibits is flagged; prose against prose is not detectable here. See the rescope below. | merged |
| T17 | Retirement candidates | ~~Withdrawn: not measurable.~~ Nothing records whether a rule was consulted, so "no run has exercised it" cannot be established from anything the board holds. See the rescope below. | dropped |
| T18 | Blast radius from history | A card's likely blast radius is proposed from what similarly-worded cards actually touched. | merged |
| T19 | Related cards | A card links to earlier cards that touched the same subsystem, so an agent inherits the prior finding. | merged |

## D. Operating the loop

Everything here currently requires a terminal.

| Id | Task | Done when | Status |
| --- | --- | --- | --- |
| T20 | Cancel a running card from the board | ~~Withdrawn: built.~~ The route, `api.cancelCard`, the board button and the `abandoned` status all exist. | built |
| T21 | Retry in place | A failed card retries against its existing worktree instead of re-dispatching from scratch. | merged |
| T22 | Requeue with a correction | Retry carries an operator note into the next run's context, delivered once. | merged |
| T23 | Pause and resume the queue | ~~Withdrawn: built.~~ Manual mode holds the queue, `resume` restarts it, and the halt state carries the reason. | built |
| T24 | Reorder the dispatch queue | ~~Withdrawn: redundant.~~ `executionOrder` already derives order from priority and position, both of which the board edits. | dropped |
| T25 | Concurrency control per board | ~~Withdrawn: built.~~ `setConcurrency` is reachable from the board header. | built |
| T26 | Per-card cost ceiling | A run that exceeds its token ceiling halts and reports, rather than running until it finishes. | merged |
| T27 | Board-level daily budget | The queue stops dispatching when the day's budget is spent, and says so on the board. | merged |

## E. What a card shows

| Id | Task | Done when | Status |
| --- | --- | --- | --- |
| T28 | Verify output on failure | ~~Withdrawn: built.~~ `VerifyReport.output` is captured and rendered in the card, deliberately only when it did not pass. | built |
| T29 | Token and duration accounting | Each card shows what its runs cost, from the run events. | merged |
| T30 | Branch diff summary | Files, insertions and deletions appear in the card, so review does not require a terminal. | merged |
| T31 | Full diff view | The branch's diff is readable in the card, per file. | merged |
| T32 | Run timeline density | The timeline distinguishes thinking, tool use, and waiting, rather than showing one undifferentiated run. | open |
| T33 | Error grouping | Repeated identical errors within a run collapse into one entry with a count. | open |
| T34 | Card search | Cards are searchable by title, body and touched path. | merged |

## F. Review and merge

| Id | Task | Done when | Status |
| --- | --- | --- | --- |
| T35 | Merge queue | ~~Withdrawn: built.~~ `mergeBranches` merges in order and verifies after each step, reporting once. | built |
| T36 | Pre-merge second opinion | A fresh agent reviews the branch and its findings enter the ledger as surprises before the gate opens. | open |
| T37 | Review checklist from the ledger | The gate shows what was established during the run, so accepting is an informed act. | open |
| T38 | Follow-up card from a rejected entry | Rejecting a ledger entry can create the card that addresses it, linked to its origin. | merged |
| T39 | Merge dry run | The board reports whether a branch would conflict, before the operator commits to merging. | merged |
| T40 | Post-merge verification | ~~Withdrawn: built.~~ `mergeBranches` runs the verify command after each merge and records the result on the step. | built |

## G. Autonomy

The point of the product: work that continues correctly while nobody is watching.

| Id | Task | Done when | Status |
| --- | --- | --- | --- |
| T41 | Scheduled dispatch window | A board can be told to work only between given hours. | merged |
| T42 | Automatic retry policy | A run that fails for a transient reason retries under a stated policy; one that fails for a stated reason does not. | merged |
| T43 | Escalation ladder | Repeated failure on one card stops that card rather than the queue, and marks it for the operator. | merged |
| T44 | Health check endpoint | One endpoint reports queue depth, in-flight runs, halt state and last event time. | merged |
| T45 | Webhook on state change | Card state changes can be posted to a configured endpoint, with the same no-interpolation discipline as `GORILLA_NOTIFY`. | merged |
| T46 | Checkpoint a long run | A run's progress is recorded at intervals so a killed process resumes rather than restarts. | open |
| T47 | Restart recovery for in-flight runs | A server restart reconciles running cards against live processes instead of leaving them in progress forever. | merged |
| T48 | Orphan worktree reaper | ~~Rescoped: it reports, it does not reap.~~ Worktrees nothing is waiting on are surfaced with the reason; removal stays an operator action. | merged |

## H. Intake

| Id | Task | Done when | Status |
| --- | --- | --- | --- |
| T49 | Card templates | A card can be created from a named template carrying its guardrails and verify command. | open |
| T50 | Import GitHub issues as cards | Issues become cards with their origin recorded, without polling anything on a timer by default. | open |
| T51 | Bulk card creation from a file | A markdown list becomes cards in one operation, with a dry run. | merged |
| T52 | Card splitting | A card too large to dispatch can be split into dependent cards, preserving its context. | open |
| T53 | Duplicate card detection | A new card that restates an existing one is flagged at creation. | merged |

## I. Command line and export

| Id | Task | Done when | Status |
| --- | --- | --- | --- |
| T54 | `gorilla export` | The whole board state renders to one reviewable markdown file, read from the database so it works with nothing serving. | merged |
| T55 | `gorilla status` | Queue state, in-flight runs and halt state, without opening the interface. | merged |
| T56 | `gorilla dispatch` | ~~Rescoped: it is an HTTP client, and has to be.~~ A card is dispatched from the command line by asking the running board. | merged |
| T57 | `gorilla verify` | The verify command runs against a card's worktree from the terminal, through the board, reporting as the board would. | merged |
| T58 | Machine-readable output | `status`, `doctor`, `export`, `dispatch` and `verify` take `--json`. `serve`, `probe`, `replay`, `init` and `backfill` do not: see the note. | merged |

## L. Found while building

Entries that came out of using the thing, which is where doc 19 says the real
defects have come from.

| Id | Task | Done when | Status |
| --- | --- | --- | --- |
| T67 | A worktree must not register as a board of its own | `gorilla status` lists five boards on this machine, four of them named after card uuids: every dispatched card's worktree is a directory, `ensureBoardForCwd` runs per directory, and each one gets a board. Found when the status command first ran against the real database. | merged |
| T68 | Say nothing about a board with nothing on it | The status output is four-fifths empty boards. Partly T67's fault, but a board with no cards is worth one line at most. | open |

## K. Beyond one agent per card

Where comparable orchestrators go once the single-card loop is solid. Listed
because each one is reachable from what exists, not because the category has them.

| Id | Task | Done when | Status |
| --- | --- | --- | --- |
| T61 | Several attempts at one card | A card can be run N times on N branches, and the board presents the attempts side by side for the operator to choose between. | open |
| T62 | Steer a running session | An operator note reaches a live run without cancelling it, and the run records that it was steered. | open |
| T63 | Keep the transcript after the worktree is gone | ~~Withdrawn: the premise is false.~~ Transcripts live in `~/.claude/projects/`, outside the worktree; `git worktree remove` does not touch them. Checked against the real database. | dropped |
| T64 | Dependency graph on the board | The dependency edges are visible as a graph, not only as a blocked badge. | open |
| T65 | Fairness across boards | Two boards on one machine cannot starve each other of the concurrency budget. | open |
| T66 | Replay a card's run as a fixture | A recorded run becomes a regression fixture, so a dispatch bug is reproduced rather than described. | open |

## J. Metrics

| Id | Task | Done when | Status |
| --- | --- | --- | --- |
| T59 | Throughput and lead time | The board reports cards added and merged, and the median time from a card being written to it merging. | merged |
| T60 | Failure taxonomy | Failures are classified by cause and counted, so the common failure is visible rather than remembered. | merged |

---

## Rescopes

**T63, 22 August 2026. Withdrawn.** The entry assumed removing a worktree
discards the run's evidence. It does not. Transcripts are written to
`~/.claude/projects/<encoded-cwd>/<session>.jsonl` and the board stores the
absolute path, so `git worktree remove` leaves them where they are - verified
against the rows in the real database rather than reasoned about. There is
nothing to fix, and building a copier would have added a second store of
something already stored.

**T48, 22 August 2026.** Written as a reaper that removes orphan worktrees on
a schedule. Doc 18 already says why that is wrong: an unreviewed worktree holds
a night of an agent's work, and deleting one because a process restarted is
unrecoverable. A scheduled remover would eventually do exactly that, at 3am, to
the one that mattered. So it finds them and says so, with the reason attached,
and removal stays where it already was - an operator action, one worktree at a
time, through a route that exists.

**T58, 22 August 2026.** "Every command takes `--json`" turned out to be the
wrong target. Five commands take it, and they are the five a script would ever
call: `status`, `doctor`, `export`, `dispatch`, `verify`. The others are not
worth it and one of them cannot be. `serve` is a long-running process whose
output is a log; `probe` and `replay` are interactive diagnostics; `init` and
`backfill` report what they changed to the person who asked them to change it.
Adding a flag to each so the row could be ticked would be five surfaces to
maintain for nobody.


**T10, T56 and T57, 22 August 2026.** T10 existed to make card operations
"reachable from the CLI", and building the CLI showed that they must not be.
Dispatch belongs to the process that owns the worktrees and supervises the
launcher: a second process starting a run would spawn an agent that dies when
the command exits, and would race the server for the same checkout - which the
card lease from T7 would refuse, correctly, leaving the operator with a command
that cannot work. So `gorilla dispatch` and `gorilla verify` are clients of the
running board, and say so when nothing is listening.

That removes T10's reason for existing. A service layer might still be worth
having for testability, but not for the reason written down, and an entry kept
alive by a rationale that turned out to be wrong is how a backlog accumulates
work nobody can justify.

**T16, 22 August 2026.** Written as "a card whose text conflicts with a
standing invariant". Deciding whether prose contradicts prose is the model's
job, and doing it badly here would produce a warning wrong often enough to be
ignored by the second week. What is checkable is a card naming a path a rule
prohibits, and that is what shipped. The weaker signal - a mention in the body
rather than in the scope - is reported as a mention, because a card can name a
file it intends to leave alone.

**T17, 22 August 2026. Withdrawn.** "An invariant no run has exercised" cannot
be established from anything the board records. Invariants are handed to a
session as text; nothing observes whether the agent read one, relied on one, or
was constrained by one. Any implementation would count something else - cards
elapsed, or paths not touched - and present it as evidence a rule is unused.
That is a worse outcome than leaving the rule in place, since the operator
would delete a standing rule on the strength of a measurement of nothing.

**T1 and T2, 22 August 2026.** Both were written as a refusal: the interface
would decline to run against a mismatched server, and the server would decline
to serve a stale bundle. Building it made the refusal look wrong. A board that
will not start because its bundle is out of date leaves the operator with
nothing, and a stale bundle is usually still fine for whatever they came to do.
Being told is the entire ask; a locked door is a different and worse product.

They also collapsed into one item. The comparison is the same in both
directions, and the second entry would have been the first one's error message.

## Audit, 22 August 2026

Six entries were withdrawn on first contact with the code. They were written
from doc 19 and from memory of the interface rather than from the source, and
six of sixty turned out to describe things that already work. They are kept in
place, struck through, rather than deleted: a backlog that quietly loses the
items it got wrong teaches nobody anything, and the same entry would have been
written again next time.

The lesson is recorded here rather than in a commit message: check the route,
the client and the component before writing the card, not after.

## Order

The dependencies are real and worth respecting.

- T9 before anything in sections C through G that adds a route, because a
  1600-line module is where parallel cards collide.
- T13 before T14, T15, T18 and T19: they all read the subsystem map.
- T21 and T22 return from the `abandoned` state T20 turned out to already set.
- T29 before T26 and T27, which need accounting before they can enforce a ceiling.
- T3 and T12 early: a contract test and a typed client turn later shape changes
  into failing tests rather than into broken screens.

Everything else is independent and can be taken in any order.
