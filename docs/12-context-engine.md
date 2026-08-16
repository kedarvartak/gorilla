# 12 - The Context Engine

## Why this document exists

Doc 08 specifies the ledger and the brief: what one card accumulated, rendered for
reading. That is card-scoped and operator-facing, and it is only part of what the
product was conceived to do.

Two things it does not cover:

1. **The project as a whole.** A ledger per card does not add up to a model of the
   repository. After twenty cards you have twenty accurate histories and no answer to
   "what is this system now, and what does it assume."
2. **The agent's side of the divergence.** Compaction resets the agent's memory to a
   summary. The board watches this happen, records what was lost, and - as specified so
   far - does nothing to repair it. The operator gets re-synchronised; the agent does not.

The Context Engine is the subsystem that closes both. It has one substrate and three
outputs.

## Two levels of context

The system maintains context at two scopes, deliberately distinct:

| | Per-card (doc 08) | Repo-wide (this document) |
| --- | --- | --- |
| Scope | One strand of work, across all its runs | The whole project |
| Unit | Ledger entries: decision, assumption, change, risk, question | Subsystem map, invariants, decision record, hot zones, open threads |
| Answers | "What happened on this task while I was away?" | "What is this system now, and what does it assume?" |
| Lifetime | Grows during runs, frozen when the card completes | Continuous, outlives every card |
| Operator surface | The card brief | The project model and the divergence band |
| Agent surface | `card-context.md` at dispatch | Invariants at session start and after compaction |

**The connector is promotion.** The card ledger is the substrate; the repo model is a
fold over it. Nothing exists at the repo level that did not begin as a traced card
entry, and nothing graduates without human confirmation - either explicit promotion, or
confirmation of a proposal the engine raises when the same statement recurs across three
or more cards.

That gate is what keeps the repo model trustworthy enough to inject into agents. Without
it, the project model would accumulate unreviewed model-generated assertions and then
feed them back into every future run, which is the compounding failure this whole product
is built to prevent.

Both levels serve both readers. That is the point: when the operator and the agent are
reading the same artifact, "in sync" is a property of the system rather than a hope.

## What "in sync" actually means

Three parties hold a model of the project, and they drift apart independently:

| Party | Model | Drifts because |
| --- | --- | --- |
| The repository | Ground truth. Code, tests, git history | Nothing. It is what it is |
| The agent | Its context window | Compaction discards it; a fresh session starts blind |
| The operator | Memory | Autonomous runs proceed unobserved (doc 01) |

Three divergences follow, and they are not symmetrical:

- **Operator vs repository** - the problem in doc 01. Addressed by the brief.
- **Agent vs repository** - the agent forgets a constraint and violates it, or re-derives
  something it already established at cost. Addressed by compaction repair, below.
- **Operator vs agent** - the two are working from different pictures, so operator
  guidance lands wrong. Addressed by both parties reading the same project model.

"Keeping us in sync" is the third row. It requires the same artifact to serve both
readers, which is the organising constraint of this document.

## The substrate

The engine invents no new capture. Its inputs are:

- **Card ledgers** (doc 08) - typed statements with sources, across every card.
- **Git** - the authoritative record of what the code actually became.
- **Operator judgements** - accepted, rejected, corrected, and promoted entries. These
  are the highest-value signal in the system because they are the only human-verified
  data it holds.

The project model is a *fold* over these, not a second extraction pipeline. This matters
for cost and for trust: everything in it traces to a ledger entry, which traces to an
event.

## Output 1: The Project Model

A living document describing the repository as it currently stands. Regenerated
incrementally as cards complete, not on a timer.

**Sections:**

- **Subsystem map.** Each significant module: one line on its purpose, the cards that
  have touched it, and its churn. Derived from file-path clustering over change entries,
  reconciled against the actual directory tree so that untouched subsystems still appear
  rather than being invisible until an agent edits them.
- **Invariants in force.** Assumptions and decisions promoted to project scope, plus
  board-level guardrails. This is the section an agent most needs and the one an operator
  most often cannot recall in full.
- **Decision record.** Project-scoped decisions in date order, each with its rejected
  alternative and the card that produced it. An ADR log that writes itself. Supersessions
  are retained and shown, because the history of reversals is where the reasoning lives.
- **Hot zones.** Files touched by the most cards, and files with the highest churn per
  card. Drift concentrates here, and so should review attention.
- **Open threads.** Unresolved `question` entries across all cards, with their age. The
  list of things nobody has decided, which otherwise exists only as a feeling.
- **Glossary.** Domain terms with the meaning the codebase actually gives them.

**Promotion.** An entry becomes project-scoped when the operator promotes it, or when the
same statement recurs across three or more cards - the second being a proposal the
operator confirms, never an automatic write. Nothing enters the project model without a
human having agreed to it at least once. That constraint is what makes the model
trustworthy enough to inject into agents.

**Relationship to CLAUDE.md.** They are different artifacts and must not be conflated.
CLAUDE.md is instructions you have chosen to give every session. The project model is a
description of what the project has become. The engine may *propose* that an invariant
graduate into CLAUDE.md (doc 10, Phase 4), but it never writes there itself. Doc 07 §8
already forbids this and the prohibition stands.

## Output 2: The Divergence Score

"Are we in sync" needs a measure, or the interface can only ever show an unread count -
and an unread count treats a schema decision and a reformatted test file as equal.

For each card, and for the board as a whole, the engine computes divergence between what
the operator has acknowledged and current ground truth. Weighted by consequence:

| Factor | Effect |
| --- | --- |
| Entry type | `decision` and `assumption` weigh far more than `change` |
| Hot-zone overlap | An entry touching a file many cards depend on weighs more |
| Supersession | A reversal of something the operator previously accepted weighs most of all - they believe something now known to be false |
| Guardrail contact | A denial, or an apparent violation, weighs heavily |
| Age | Unreviewed decisions accrue weight; unreviewed changes do not |
| Volume | Sublinear. Two hundred change entries are not a hundred times more urgent than two |

The score's only job is **ordering attention**: which card to open first, and what to
read first inside it. It is deliberately not shown as a precise number, because a number
implies a precision the weighting does not have. The interface renders it as a band -
in sync, drifting, diverged - with the top contributing reasons named. A score you cannot
interrogate is a score you should not trust.

The board-level score drives the resync digest ordering (doc 09, screen 4). The
per-card score drives the unseen badge's prominence.

**The reversal case deserves emphasis.** The single most dangerous state is not "the
operator has not read something." It is "the operator read something, accepted it, and it
has since been reversed." They are now confidently wrong, and nothing in a conventional
unread count surfaces that. Making it the heaviest term is the point of having a
weighting at all.

## Output 3: Compaction repair

The agent-facing half, and the mechanism the rest of the design was missing.

Verified against the hooks reference: `SessionStart` accepts a `compact` matcher, and
plain stdout from a `SessionStart` hook is added as context the model can see and act on
- `UserPromptSubmit`, `UserPromptExpansion`, and `SessionStart` are the three events with
this property. `PostCompact`, by contrast, is non-blocking and display-only; its output
reaches the user, not the model. Compaction repair therefore runs through
`SessionStart:compact`, and `PostCompact` is telemetry.

The sequence, completing the one begun in doc 07 §5:

1. `PreCompact` fires. The engine extracts the about-to-be-discarded window into ledger
   entries and records the marker. Already specified.
2. Compaction occurs. The agent's memory becomes a summary.
3. `SessionStart` fires with matcher `compact`. The engine responds with a compact
   repair block: the card's guardrails, the invariants in force from the project model,
   the decisions and assumptions established *in this run* before compaction, and the
   open questions. Bounded hard - a repair block that itself consumes the context window
   defeats the purpose.
4. The agent resumes holding the things it just lost.

**Budget.** The repair block is capped at a configurable token ceiling, defaulting low.
Priority order when trimming: guardrails first, then in-run decisions, then invariants,
then open questions. Guardrails are never trimmed; if they alone exceed the ceiling, the
engine says so in the interface, because that is a sign the card is over-specified.

**This is the feature with the highest leverage in the product.** Everything else makes
the operator better informed after the fact. This one makes the agent measurably less
likely to do the wrong thing in the first place, using information the board already
captured for another purpose. It costs one hook response.

**It is also the feature most likely to be wrong in an interesting way.** Re-injecting a
stale or mis-extracted constraint actively harms the run - worse than injecting nothing,
because the agent will act on it. Repair therefore draws only on operator-accepted
entries and explicit guardrails, plus same-run extractions which are the freshest
material available. Unreviewed cross-card ledger content is not eligible. The engine
prefers a thin, certain repair block to a rich, speculative one.

## Session priming

The same mechanism serves the non-compaction cases. On `SessionStart` with matcher
`startup` or `resume`, and in the `card-context.md` handed to launched sessions
(doc 07 §3), the engine supplies a project brief: subsystem map, invariants, and the open
threads relevant to this card's scope.

This is what makes a fresh session start informed rather than blind, and it is the same
document the operator reads. That identity is the point: when both parties are working
from one artifact, "in sync" stops being an aspiration and becomes a property of the
system.

## Cost

The project model folds existing ledger entries and is largely mechanical. Model calls
are needed for two things only: composing section prose when the model materially
changes, and detecting that a recurring statement across cards is the same statement.
Both are infrequent and both are cached by content hash.

Divergence scoring is arithmetic over stored fields. No model calls at all.

Compaction repair assembles already-extracted content under a token budget. No model
calls on the hook path, which is also what keeps it inside the latency budget in doc 06.

The engine is therefore cheap relative to doc 08's per-turn extraction, which remains the
dominant cost.

## Failure modes

| Failure | Consequence | Handling |
| --- | --- | --- |
| Project model drifts stale | Operator and agents both trust an outdated picture | Every section carries the timestamp and card of its last update; sections not refreshed within a threshold are visibly marked stale rather than silently served |
| A wrong invariant is promoted | Injected into every future run; actively harmful | Promotion requires human confirmation; any invariant can be demoted, and demotion is retroactive - the interface names the runs that received it |
| Repair block crowds the window | Defeats the purpose of compaction | Hard token ceiling with the stated trim order; never trims guardrails |
| Divergence score mis-weights | Operator's attention is directed at the wrong card | Score is always expandable to its contributing reasons; weights are configurable per board and are tuned against real use, not fixed in advance |
| `SessionStart:compact` does not fire as documented | Compaction repair silently does nothing | Verified explicitly in the Phase 0 exit gate, alongside `PreCompact`. If it does not fire, the fallback is injecting repair on the next `UserPromptSubmit`, which also accepts stdout as context |

## Roadmap placement

- **Phase 0** additionally verifies that `SessionStart` fires with matcher `compact`
  after an auto-compaction, and that its stdout reaches the model. This is a small
  addition to an existing gate and de-risks the highest-leverage feature at the earliest
  possible point.
- **Phase 2** builds the project model and the divergence score, alongside the ledger
  they fold. The Phase 2 exit gate gains one criterion: the project model, read cold,
  correctly describes the repository to someone who has not seen it.
- **Phase 3** builds compaction repair and session priming, once operator-accepted
  entries exist to draw on. It cannot come earlier: repair drawing on unreviewed
  extractions is the failure mode above.

## The measurement

Doc 08 measures time-to-resync for the operator. The engine adds a second, symmetrical
measurement for the agent:

Across runs that compact at least once, compare the rate of **post-compaction constraint
violations** - the agent contradicting a guardrail or a decision established before
compaction - with repair on versus off. This is directly observable from guardrail
denials and superseded entries, requires no human judgement to score, and is the honest
test of whether the engine keeps the agent in sync or merely appears to.
