# 19 - Status

The design documents in this folder describe what Gorilla is for and how it should
work. They are kept as written, because a design record that is edited to match
whatever got built stops being a record and becomes a description.

This document is the other half: what actually exists, and what does not. It is the
one file here that is expected to go out of date, so it says when it was last true.

**Last verified: 19 August 2026, against `main` at 639 passing tests.**

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

Against doc 10's phases: Phase 0 and Phase 1 are complete and were verified against
their exit gates (docs 15 and 17). Phase 2 is built. Most of Phase 3 is built - the
gates, the verify check, compaction repair, the digest, dependencies honoured by the
dispatcher - though its exit gate has not been run as a single unbroken cycle.

## What is not built

- **Promotion of ledger entries to guardrails or project invariants.** Doc 12's
  outputs 1 and 2. Judgement is recorded and fed back into the next run's context,
  but an accepted assumption never becomes a rule.
- **The project model.** Subsystem map, invariants, and cross-card context. Doc 12
  describes it; only the per-card half exists.
- **Queued corrections delivered on resume**, notifications, markdown export.
- **Backfill from transcripts** for sessions that ran while the board was closed.

## What has never happened

Kept separate from the list above, because "the tests pass" and "this has worked once
in the real world" are different claims and conflating them is how a product acquires
features nobody has ever used.

- **A real compaction.** `PreCompact` and `PostCompact` have never fired against this
  board. The repair path is proven by the probe in doc 14 and by tests through the
  hook, and has never run after an actual compaction.
- **A real conflict resolution.** Every test drives the resolver with a shell script
  standing in for the agent.
- **`TaskCreated` and `TaskCompleted`.** Registered, never delivered.
- **An unattended overnight batch that completed clean.** The one attempt found four
  defects, which was worth more than the batch would have been.

## How this was built

Fourteen cards have been dispatched to agents and merged through the board itself, out
of fifty-four merged pull requests. The board has observed its own construction since
Phase 1, which is doc 10's stated intent and the reason several defects were found at
all: a false "merged and verified" on an empty branch, a run that read as in progress
for twenty-five hours, and worktrees forgotten on every restart were each found by
using the thing rather than by testing it.
