# 08 - The Context Ledger and the Brief

This is the product. Everything else is plumbing that feeds it.

This document is card-scoped and operator-facing. Its other half is
[doc 12](12-context-engine.md), which folds these per-card ledgers into a project-wide
model, defines how divergence is measured, and feeds the same material back to the agent
after compaction. Read them together.

## The claim

The operator's problem is not missing data - the transcript holds everything. The
problem is that the data is in a form whose reading cost exceeds its perceived value,
so it is never read, so drift accumulates unobserved (doc 01).

The ledger's job is to change that ratio: to convert an unbounded transcript into a
bounded, typed, traceable set of statements that can be read in two minutes and trusted
because each one links back to its evidence.

The design borrows directly from the context engineering literature (doc 03). If
external memory is the accepted remedy for the agent's finite context, the same
artifact serves the operator's. The novelty is not the artifact - it is that the
artifact is captured automatically at the moment of loss, rather than depending on
someone remembering to write it down.

## Extraction

### When extraction runs

| Trigger | Window extracted | Priority |
| --- | --- | --- |
| `PreCompact` | The context about to be discarded | Highest. This content will not exist again |
| `Stop` | The turn just completed | High. Natural narrative boundary |
| `SubagentStop` | The subagent's contribution | High. Its entire context window is discarded and only `last_assistant_message` survives into the parent |
| `PostToolUseFailure` | The failure and what followed | Medium. Failures precede risks |
| Operator opens a stale card | Any unprocessed events | On demand |
| Explicit "resynthesise" | The full run | Manual |

Extraction is never on the hook response path. It is queued and performed after the
response returns (doc 06).

### What is extracted mechanically

These entries require no model call and are always available, even with no API access
or budget:

- **Change entries** from `PostToolUse` on Edit/Write/NotebookEdit: file path, lines
  added and removed, aggregated per file per run.
- **Risk entries** from `PostToolUseFailure`, `StopFailure`, and `system/api_retry`.
- **Change entries** from `Bash` calls matching installation, migration, or schema
  patterns - a dependency added or a migration run is material even when the agent did
  not narrate it.
- **Goal verdicts** from the transcript, including the evaluator's stated reason for
  each `not yet met` - a free, high-signal record of what the agent believed was left.
- **Git reality** at run end: the actual diff against `headShaAtStart`, which is the
  authoritative answer to "what changed" independent of any agent claim.

That last item is a quiet but important one. It permits a **claim-versus-reality
check**: files the agent discussed but did not change, and files it changed but never
mentioned. The second set is where unobserved drift lives.

### What is extracted by model

A single structured extraction call per window, using a small fast model by default,
returning typed entries against a fixed JSON schema. The prompt directs the model to
produce statements that a competent engineer who was absent could act on, with
constraints:

- One sentence per `statement`; supporting matter in `detail`.
- A `decision` must name the alternative that was not taken. A decision with no
  alternative is a change, not a decision, and should be typed as one.
- An `assumption` must be something not verified by tool output during the window.
- Do not restate the diff. Change entries come from tool events; the model's job is
  reasoning, not enumeration.
- Emit nothing rather than emit filler. An empty extraction from a mechanical turn is
  the correct output, and the pipeline must not reward volume.

Every returned entry carries the event IDs it was derived from. Entries whose sources
cannot be resolved are discarded rather than shown, because an unfalsifiable claim in
the ledger is worse than a gap.

### Deduplication and supersession

Extraction windows overlap and long runs revisit topics. Before insertion, each
candidate entry is compared against existing entries on the same card by embedding
similarity plus file-path overlap. Outcomes:

- Near-identical to an existing entry: discarded, with the source event IDs appended to
  the existing one, which raises its confidence.
- Contradicts an existing entry: the old one is marked `supersededBy` the new. Both are
  retained, and the brief surfaces the reversal explicitly - "this was decided, then
  reversed" is high-value information the operator would otherwise never see.
- Otherwise: inserted.

## Cost control

An unbounded summarisation pipeline attached to an unbounded agent loop is an
unbounded bill. Controls:

- **Per-card model selection** (doc 05). Each card carries a `synthesisModel`, defaulting
  to the board setting. The operator raises it for cards where the reasoning is subtle
  and lowers it for mechanical work, at planning time, when the judgement is easiest to
  make.
- Within a card, the default policy is a small fast model (Haiku 4.5) for routine turn
  extraction, escalating to the card's `synthesisModel` for `PreCompact` windows and for
  brief composition - the two places where the content is irreplaceable or the reading
  audience is human. A card set to a small model everywhere is a valid choice and the
  interface says what it costs in brief quality.
- A per-card and per-day token budget, configurable, enforced in the pipeline. On
  exhaustion the system degrades to mechanical extraction only and says so in the
  interface rather than silently stopping.
- Windows are truncated to a token ceiling, keeping the tail and any content matching
  decision-shaped patterns.
- Extraction results are cached by content hash, so resynthesis of unchanged windows
  is free.
- Turns that produced no mutating tool calls and no assistant text above a length floor
  skip model extraction entirely.

Observed cost must be displayed in the interface. A tool that spends money in the
background without showing the figure will not be trusted.

## The Brief

The brief is what the operator actually reads. It is regenerated from the ledger when
stale, cached, and versioned - the version number is what an Acknowledgement records.

Fixed structure, in this order, because the order encodes priority:

**1. Since you last looked**
Computed against `card.lastSeenAt`. The direct answer to the problem in doc 01: what
has happened in your absence, and nothing else. If nothing has changed since the last
view, this section says so in one line and the operator can stop reading immediately.
This section is the single most important element in the product.

**2. State of the work**
Two to four sentences. Where the card stands, what the agent believes remains, and the
current goal verdict with the evaluator's own reason.

**3. Decisions**
Each with its rejected alternative. Reversals marked. Unreviewed entries visually
distinct from accepted ones.

**4. Assumptions in force**
The list an operator is most likely to want to challenge, and the one whose absence
causes the most expensive late surprises.

**5. Blast radius**
Files touched, grouped by subsystem, with line counts and a link to the real diff.
Includes the claim-versus-reality discrepancies described above.

**6. Risks and open questions**
Failures, retries, skipped verification, things needing human judgement.

**7. Compaction and continuity**
Whether context was compacted during this card's runs, when, and what was preserved at
each point. Makes explicit which parts of the agent's own memory are now summaries.

**8. Evidence**
Collapsed by default. Raw event timeline, transcript links, full diffs. Present so that
every claim above can be checked, absent from the default reading path (P3).

## Interaction

The brief is not read-only. Each ledger entry supports four operator actions:

- **Accept** - the statement is correct. Accepted entries are eligible for injection
  into future sessions on this card, which is how the ledger closes the loop and becomes
  input rather than only output.
- **Reject** - the statement is wrong. Queued as a correction to the agent (doc 07, §7).
- **Correct** - edit the statement. The operator's version supersedes the model's and is
  marked as operator-authored, permanently.
- **Promote** - elevate to a card guardrail, so it is injected into every future run on
  this card and, where expressible, enforced as a deny rule (doc 05).

Promotion is the mechanism by which a one-time realisation becomes a durable rule
without the operator having to edit CLAUDE.md and reason about how it will affect
unrelated work.

## Evaluation

A synthesis feature with no evaluation is a plausible-text generator. The quality bar
must be measurable before the pipeline is trusted, and this is the Phase 2 exit gate
(doc 10):

- **Recall test.** Take a completed real run. Have the operator list, from the full
  transcript, the decisions and assumptions that mattered. Compare against the ledger.
  Target: no missed item that would have changed a subsequent action.
- **Precision test.** Fraction of entries the operator rejects as noise. Target: below
  15 percent. Noise is more damaging than omission here, because it trains the operator
  to skim, which is the original failure mode returning.
- **Time-to-resync.** The headline metric. Time from opening a card to the operator
  self-reporting an accurate model of its state, measured against reading the raw
  transcript for the same run. Target: five times faster, under two minutes absolute.
- **Traceability.** Every entry resolves to at least one real event. Target: 100
  percent, enforced in code rather than measured.
