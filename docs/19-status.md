# 19 - Status

The design documents in this folder describe what Gorilla is for and how it should
work. They are kept as written, because a design record that is edited to match
whatever got built stops being a record and becomes a description.

This document is the other half: what actually exists, and what does not. It is the
one file here that is expected to go out of date, so it says when it was last true.

**Last verified: 22 August 2026, against `main` at 1,224 passing tests.**

## What is built

| Capability | State | Where |
| --- | --- | --- |
| Hook ingest, 17 events, p99 under budget | Working | `src/server/ingest/` |
| Session binding: launched, attached, inferred | Working | `src/server/binding/` |
| Board, columns, cards, dependencies, priority | Working | `src/server/api/`, `src/web/` |
| Plan intake from a Claude Code conversation | Working | `/gorilla:plan` |
| Dispatch, one worktree per card, isolated branches | Working | `src/server/dispatch/`, `src/server/worktree/` |
| Verify command run by the board, not the agent | Working | `src/server/verify/` |
| Mechanical ledger, no model, no cost | Working | `src/server/ledger/mechanical.ts` |
| Model extraction, on the Claude Code quota | Working | `src/server/ledger/service.ts` |
| The brief, with since-you-last-looked | Working | `src/server/brief/` |
| Operator judgement on entries: accept, reject, correct | Working | `POST /api/ledger/:id/status` |
| Merge gate: no merge while surprises are unjudged | Working | `src/server/review/gate.ts` |
| Queue gate: no next card while surprises are unjudged | Working | `src/server/dispatch/dispatcher.ts` |
| The reviewer: merge many branches, verify after each | Working | `src/server/review/merge.ts` |
| Conflict resolution rather than conflict reporting | Working, never used in anger | `src/server/review/resolve.ts` |
| Stall detection: denial storms and silence | Working | `src/server/dispatch/stall.ts` |
| Compaction repair | Working, never triggered by a real compaction | `src/server/context/repair.ts` |
| Morning digest, live activity feed | Working | `src/web/src/Digest.tsx`, `Activity.tsx` |
| Staleness: notice a card that may already be done | Working | `src/server/cards/staleness.ts` |
| Promote an accepted entry to a card guardrail | Working | `src/server/ledger/promote.ts` |
| Corrections delivered to the next session start | Working | `src/server/context/repair.ts` |
| Backfill runs from transcripts | Working | `src/server/transcript/backfill.ts` |
| Board invariants, handed to every dispatched card | Working | `src/server/db/schema.ts`, `src/server/launcher/args.ts` |
| Export a card's brief as markdown | Working | `src/server/brief/markdown.ts` |
| Run a command when the queue halts | Working | `src/server/notify/notify.ts` |
| Warn when the hooks point at another board | Working | `src/hooks/target.ts` |
| Subagent work shown as its own | Working | `src/server/agents/subagents.ts` |
| Digest split into news and backlog | Working | `src/server/cards/activity.ts` |
| What a run cost, recorded per run | Working | `src/server/launcher/cost.ts` |
| Per-card token ceiling, enforced by killing the run | Working | `src/server/dispatch/dispatcher.ts` |
| Daily token budget per board, stopping the queue | Working | `src/server/dispatch/budget.ts` |
| A failing card blocked without stopping the night | Working | `src/server/dispatch/dispatcher.ts` |
| Automatic retry, only on evidence of a transient fault | Working | `src/server/dispatch/retry.ts` |
| Retry in place with an operator's correction | Working | `src/server/dispatch/dispatcher.ts` |
| Dispatch window, holding the queue outside its hours | Working | `src/server/dispatch/window.ts` |
| Cards reconciled out of running after a restart | Working | `src/server/cards/reconcile.ts` |
| Health as facts rather than a hardcoded ok | Working | `src/server/health.ts` |
| Subsystem map: what each card touched, git and claimed | Working | `src/server/cards/subsystems.ts` |
| Guardrails proposed from accepted entries | Working | `src/server/ledger/propose.ts` |
| Project rules proposed from rules repeated on cards | Working | `src/server/cards/invariant-proposals.ts` |
| Branch diff and per-file patch inside the card | Working | `src/server/worktree/diff.ts` |
| Merge forecast, without attempting the merge | Working | `src/server/review/forecast.ts` |
| Card search, including by the files a card touched | Working | `src/server/cards/search.ts` |
| Duplicate card warning at creation | Working | `src/server/cards/duplicates.ts` |
| Throughput, lead time and a failure taxonomy | Working | `src/server/metrics.ts` |
| Webhook on halt and on a card settling | Working | `src/server/notify/webhook.ts` |
| `gorilla status`, with `--json` | Working | `src/cli/commands/status.ts` |
| Stale-interface warning, in serve, health and the board | Working | `src/server/web/stamp.ts` |
| One dispatcher per card, enforced by the database | Working | `src/server/dispatch/lease.ts` |
| Fairness between boards sharing a machine | Working | `src/server/dispatch/fairness.ts` |
| Resuming a run that was cut off | Working | `src/server/dispatch/resume.ts` |
| A card scoped against a project rule, flagged | Working | `src/server/cards/contradictions.ts` |
| Blast radius guessed from similar cards | Working | `src/server/cards/blast-radius.ts` |
| A card cloned, and a card split | Working | `src/server/api/board-routes.ts` |
| A list of tasks read from a file | Working | `src/server/cards/intake.ts` |
| GitHub issues read onto the board | Working, never against real GitHub | `src/server/cards/github.ts` |
| A rejection turned into the card that addresses it | Working | `src/server/api/brief-routes.ts` |
| A second opinion from a session that did not write it | Working, never run for real | `src/server/review/second-opinion.ts` |
| What the operator is about to accept, assembled | Working | `src/server/review/readiness.ts` |
| Two attempts compared side by side | Working | `src/server/review/compare.ts` |
| Where a run's time went, and what it kept retrying | Working | `src/server/timeline/` |
| The order the board will work in, and why | Working | `src/server/cards/plan.ts` |
| A run turned back into a replayable fixture | Working | `src/server/fixtures/from-run.ts` |
| `gorilla status`, `export`, `add`, `import`, `fixture`, `dispatch`, `verify` | Working | `src/cli/commands/` |

Against doc 10's phases: Phase 0 and Phase 1 are complete and were verified against
their exit gates (docs 15 and 17). Phase 2 is built. Most of Phase 3 is built - the
gates, the verify check, compaction repair, the digest, dependencies honoured by the
dispatcher - though its exit gate has not been run as a single unbroken cycle.

## What is not built

Doc 20's list is empty: seventy-four entries built, five withdrawn with reasons.
What remains undone is therefore what nobody has written down yet, plus one
thing that was written down and deliberately not built:

- **N runs of one card on N branches.** Comparing two attempts works by cloning
  the card and comparing the two, because re-keying the worktree path, the lease
  and the runs table is not worth a comparison view. Doc 20 records the argument.
- **The project model, in full.** Doc 12's cross-card context. Board-level invariants
  reach every dispatched card, marked as project rules rather than card rules, and the
  subsystem map now records which paths each card touched - from git and from the run's
  own account, kept apart - and surfaces the earlier cards that worked on the same
  files. What is not there is anything that reads the map and proposes a rule from it.
- **Extraction of invariants from the ledger.** Built, in both halves. The board
  shortlists accepted entries that read as standing rules and offers each as a card
  guardrail, saying in advance whether it could be enforced or only asked for; and it
  offers a rule carried by three or more cards as a project rule, naming the cards that
  carry it. Nothing is ever applied without the operator saying yes, which is doc 12's
  constraint rather than a limitation of the implementation.

## What has never happened

Kept separate from the list above, because "the tests pass" and "this has worked once
in the real world" are different claims and conflating them is how a product acquires
features nobody has ever used.

- **A real compaction.** `PreCompact` and `PostCompact` have never fired against this
  board. The repair path is proven by the probe in doc 14 and by tests through the
  hook, and has never run after an actual compaction.
- **A real conflict resolution.** Every test drives the resolver with a shell script
  standing in for the agent.
- **`TaskCreated` and `TaskCompleted`.** Registered, never delivered - still true
  after checking the database directly. The subagent view is therefore built on
  `SubagentStart`, `SubagentStop` and the `agent_id` carried by tool events, which do
  arrive; the Task events will group under the same `agent_id` if they ever fire.
- **A halt notification reaching a real operator.** `GORILLA_NOTIFY` is tested,
  including against a card title written to break a shell, and has never woken anybody
  up. `GORILLA_WEBHOOK` has never posted to a real endpoint either.
- **A token ceiling or a daily budget stopping a real run.** Both are enforced in
  tests against a fake CLI. Neither has stopped anything that was spending money.
- **A dispatch window holding a real overnight queue.** The clock arithmetic is
  tested; no board has yet gone to sleep at 07:00 and woken at 22:00.
- **A second opinion from a real session.** The reviewer is tested against an
  injected runner, so no test spawns a CLI or spends anything. Nothing has yet
  asked a real model to read a real branch, which means the prompt is unproven -
  the part of this most likely to be wrong.
- **A GitHub import against real GitHub.** `gorilla import` is tested against a
  stubbed transport and has never been given a token. What is proven is the shape
  handling; what is not is that GitHub answers the way the tests assume.
- **An unattended overnight batch that completed clean.** The one attempt found four
  defects, which was worth more than the batch would have been.

## How this was built

Fourteen cards have been dispatched to agents and merged through the board itself, out
of one hundred and twenty-three merged pull requests. The board has observed its own construction since
Phase 1, which is doc 10's stated intent and the reason several defects were found at
all: a false "merged and verified" on an empty branch, a run that read as in progress
for twenty-five hours, and worktrees forgotten on every restart were each found by
using the thing rather than by testing it.

## The backlog, as of 22 August 2026

Doc 20 holds seventy-nine numbered items across two waves and none are open.
Seventy-four are built or were found already built; five were withdrawn on
contact with the code, struck through rather than deleted, each with the
argument that killed them.

The second wave was written after the first was finished, from things this
work established rather than from a fresh brainstorm: routes that existed and
nothing called, a request whose cost had been measured rather than guessed at,
and the signals the morning view had been built before.

The withdrawals are the part worth reading. Two were unmeasurable - an
invariant nobody can prove went unused, a running session with no channel to
steer it through. One was a false premise: worktree removal does not discard a
transcript, which lives elsewhere. One collapsed into another. One was rejected
on cost: N attempts per card would re-key the three structures that stop two
agents sharing a checkout.

Several more were narrowed rather than dropped. A reaper became a report, a
template store became a clone, a drawn graph became an ordered list, and a
prose contradiction check became a path check - in each case because the
written version was either unreachable or would have asserted something the
board cannot see.

Two of them came out of using the product rather than reading it, which is the
pattern doc 10 predicted and this document keeps recording. `gorilla status`, on
its first run against the real database, reported five boards where there is one
project: every dispatched card's worktree had been registering as a board of its
own. The fix landed in the next pull request; the boards it already created are
reported by `gorilla doctor` and removed by nobody, because a wrong reattachment
would move one card's history onto another.
