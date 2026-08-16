# 10 - Roadmap

Each phase has an exit gate that must be demonstrated before the next begins. The gates
are deliberately behavioural rather than feature checklists, because the risk in this
product is not "did we build it" but "does it actually reduce time-to-resync".

Gorilla is developed using Claude Code in the modes it is designed to observe. From
Phase 1 onward it observes its own construction, which is the fastest available source
of realistic event streams and honest feedback.

## Phase 0 - Prove the pipe

Scope: a Fastify server that receives every hook event over HTTP and writes it to
SQLite. `gorilla init` writes the settings. A single unstyled page streams events over
SSE. No cards, no board, no synthesis.

Also in scope: a **fixture recorder** that captures a real session's full hook stream to
disk, and a replay harness that feeds it back into the server. Everything after this
phase is tested against recorded reality rather than invented payloads, so this is not
optional tooling.

**Exit gate.** Run a genuine forty-minute `/goal` session in auto mode on a real
project, long enough to trigger an auto-compaction. Every event in doc 07's
configuration is received, ordered, and persisted, with no measurable slowdown of the
agent. Then three specific confirmations, all concerning compaction, because the two
highest-leverage features in the product depend on them:

1. `PreCompact` fires, and the transcript tail is readable at that moment (doc 07 §5).
2. `SessionStart` fires with matcher `compact` after the compaction (doc 12).
3. Text returned from that hook reaches the model - verified by injecting a distinctive
   token and asking the agent about it.

If any of the three fails, doc 12's compaction repair needs its fallback path and the
roadmap should be re-planned before Phase 1 rather than after Phase 2. This is a few
hours of work that de-risks the most valuable thing the product does.

## Phase 1 - Plan, dispatch, observe

The phase that makes the loop in doc 00 real, end to end, with no synthesis yet.

Scope: boards bound to directories; cards with the doc 05 column set, guardrails, and
per-card model selection; drag and drop; the `/gorilla:plan` command and the plan intake
endpoint; goal composition with the authoring warnings; launched mode with `claude -p`
supervision, guardrail-derived launch flags, `card-context.md` injection, and
cancellation; the serial dispatcher with manual and automatic modes; the run model; the
timeline screen; transcript tailing for token usage and the utilization ring; git diff
capture at run boundaries; mechanical ledger entries only, no model calls.

Attached-mode binding - `/gorilla:claim`, inferred cards, and `SessionStart` context
injection - is also in this phase but secondary. It is small once launched mode exists,
and without it any terminal session is a blind spot, which is the failure the product
exists to remove.

**Exit gate.** In one sitting: hold a planning conversation, land six cards on the board
with guardrails and models set, dispatch them, and let them run unattended. On return,
every run is correctly attributed, guardrail denials are recorded, and the mechanical
ledger - files changed, failures, goal verdicts, claim-versus-reality discrepancies - is
accurate enough to be worth reading on its own.

That last clause is the real test. If mechanical extraction alone is not useful, the
model layer will not save it.

## Phase 2 - The ledger

Scope: the model extraction pipeline, deduplication and supersession, the brief with all
eight sections, "since you last looked", the four operator actions, budget enforcement
and spend display, and the evaluation harness.

Also in scope: the project model and the divergence score (doc 12), which fold the
ledger entries this phase produces and are therefore cheap to add here.

**Exit gate.** The four measurements in doc 08: recall with no consequential omissions,
precision above 85 percent, traceability at 100 percent, and time-to-resync under two
minutes and at least five times faster than reading the transcript, measured across at
least ten real completed cards.

Plus one from doc 12: the project model, read cold, correctly describes the repository
to a reader who has not seen it - tested by handing it to a fresh Claude Code session
with no other context and asking it to answer questions about the system.

This is the phase that determines whether the product exists. It should be scheduled
with the expectation that the extraction prompt requires several iterations, and it
should not be rushed to reach Phase 3.

## Phase 3 - Closing the loop

Scope: review gates in all three policy settings, off by default, including the
deterministic verify check; promotion of ledger entries to guardrails and to project
invariants; compaction repair and session priming (doc 12), which become safe once
operator-accepted entries exist to draw on; queued corrections delivered on resume;
notifications; the resync digest; markdown export; card dependencies honoured by the
dispatcher.

**Exit gate.** A card is planned, dispatched, runs unattended to completion, is held at
the gate, is reviewed in under two minutes, has one assumption corrected and one promoted
to a guardrail, and both demonstrably reach the next run. The full cycle, once, end to
end.

Gates ship off by default and are enabled by the operator once the Phase 2 briefs have
earned it (doc 11, R4). Building them here rather than earlier is deliberate: the
authority to hold work should be granted to a tool that has already proved its briefs
are worth stopping for.

## Phase 4 - Depth

Candidate work, sequenced by evidence from real use rather than committed now:

- A channels plugin for live board-to-agent messaging, once channels leave research
  preview.
- Worktree isolation per card, using `--worktree` and the `WorktreeCreate` hooks, if
  parallel cards prove genuinely useful.
- Cross-card and full-text search over the ledger via FTS5.
- Ledger-informed CLAUDE.md suggestions: a promoted constraint recurring across many
  cards is a candidate project rule, proposed to the operator rather than written
  automatically.
- Backfill of historical sessions from transcripts, giving an existing project instant
  history.
- Packaging as an npm binary, and possibly a Claude Code plugin so `gorilla init`
  becomes `/plugin install`.

## Explicitly deferred indefinitely

Multi-agent support, team features, hosted deployment, mobile. Each is listed as a
non-goal in doc 04 with reasoning. They are recorded here so that deferral is a decision
on the record rather than an oversight.

## Sequencing rationale

The order is chosen so that the riskiest assumption is tested earliest at the lowest
cost. The riskiest assumption is not "can we receive hook events" - doc 02 establishes
that and Phase 0 confirms it cheaply. It is "can automated synthesis produce something a
human trusts enough to rely on instead of reading the transcript." That is Phase 2, and
everything before it exists to make Phase 2 measurable against real data.

Building the board first is not the shortest path to that answer, but it is the only
path that generates the realistic event streams Phase 2 needs. Synthesising against
invented transcripts would produce a pipeline tuned to fiction.
