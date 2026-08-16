# 00 - Overview

**Gorilla** is a local-first, web-based Kanban board for driving Claude Code sessions in
autonomous modes (`/goal`, auto mode, long-running turns) without losing situational
awareness of what is being built.

## The name

From the selective-attention experiment: observers counting basketball passes fail to
notice a person in a gorilla suit walk through the middle of the scene. The event is
plainly visible; attention is simply allocated elsewhere. That is the failure this tool
exists to prevent, and doc 01 states it precisely.

## One-sentence definition

A Kanban board where each card is bound to a real Claude Code session, and the card
accumulates a durable, human-readable record of everything the agent did, decided,
touched, and forgot.

## The distinction that matters

Most tools in this space are **orchestrators**: they exist to run more agents in
parallel, faster. Gorilla is a **comprehension instrument**: it exists so that after
an agent has run for forty minutes unattended, the operator can regain an accurate
mental model of the repository in under two minutes.

Throughput is not the metric. Time-to-resync is the metric.

## The operating loop

1. **Plan together.** You and Claude decompose the work in a planning session. That
   session writes the resulting tasks onto the board as cards, each with a goal
   condition, guardrails, and a chosen model.
2. **Dispatch.** The board starts a Claude Code session per card and hands it the card's
   specification as context. Cards are worked autonomously, one at a time by default.
3. **Accumulate.** While the agent runs, the board captures decisions, assumptions,
   changes, risks, and everything discarded at each compaction into a durable ledger
   attached to the card.
4. **Resync.** You come back. The card's brief tells you what happened since you last
   looked, in under two minutes. You accept, correct, or promote what the agent decided.
5. **Feed back.** Accepted entries and promoted constraints become input to the next run
   on that card, so the loop tightens rather than repeating.

Steps 1 and 2 are how work starts; steps 3 to 5 are the product. Sessions you start
yourself in the terminal are also observed and attributed (doc 07), so nothing escapes
the board just because it began outside it.

## Document map

| Document | Contents |
| --- | --- |
| [01-problem.md](01-problem.md) | The context-shift problem, stated precisely, with the failure modes it produces |
| [02-research.md](02-research.md) | Verified integration surfaces in Claude Code, and what each one can supply |
| [03-prior-art.md](03-prior-art.md) | Existing tools, what they solve, and where the gap is |
| [04-principles.md](04-principles.md) | Design principles and explicit non-goals |
| [05-concepts.md](05-concepts.md) | Domain model: boards, cards, sessions, events, the ledger |
| [06-architecture.md](06-architecture.md) | Processes, storage, data flow, technology selection |
| [07-integration.md](07-integration.md) | The exact contract with Claude Code: hooks, transcripts, launch, binding |
| [08-context-ledger.md](08-context-ledger.md) | The core feature: what is captured, how it is summarized, how it is presented |
| [09-interface.md](09-interface.md) | Screen-by-screen interface specification |
| [10-roadmap.md](10-roadmap.md) | Phased delivery with explicit exit gates |
| [11-risks.md](11-risks.md) | Risks, dependencies on unstable surfaces, and open decisions |
| [12-context-engine.md](12-context-engine.md) | The project model, the divergence score, and compaction repair - keeping operator and agent on one picture |
| [13-phase-0-tasks.md](13-phase-0-tasks.md) | The ten Phase 0 tasks, in card shape, with goal conditions and dependencies |
| [14-compaction-probe-findings.md](14-compaction-probe-findings.md) | T9 findings: what Claude Code actually does at compaction, measured |
| [15-phase-0-verification.md](15-phase-0-verification.md) | T10: the Phase 0 exit-gate report, with the compaction loop confirmed end to end |
| [16-phase-1-tasks.md](16-phase-1-tasks.md) | The twelve Phase 1 tasks: plan, dispatch, observe - with no synthesis |
| [17-phase-1-verification.md](17-phase-1-verification.md) | P12: the Phase 1 exit-gate report, and the two defects only an end-to-end run could find |

## Reading order

For approval purposes, read 01, 04, 08, and 12. Those four carry the argument. The rest
is implementation detail that follows from them.

Docs 08 and 12 are two halves of one subsystem: 08 is per-card and operator-facing, 12
is project-wide and serves the agent as well. Read them together.

## Status

**Phase 0 and Phase 1 are complete.** T1 to T10 (doc 13) and P1 to P12 (doc 16) are
shipped. Docs 14, 15 and 17 record what was measured, including the corrections where a
measurement disproved an earlier assumption.

The loop in this document now runs end to end: plan a conversation, land cards, dispatch
a supervised session, and read a mechanical ledger of what happened. Whether that ledger
is *worth reading* is the Phase 1 gate, and doc 17 leaves it open for the operator to
answer over a week of real work. Phase 2 - synthesis - should not begin until it is.
