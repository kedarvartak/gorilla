# 04 - Principles and Non-Goals

## Principles

### P1. Comprehension over throughput

Every feature is judged by whether it reduces time-to-resync: the interval between an
operator returning to a card and holding an accurate model of its state. Features that
increase agent throughput without improving comprehension are out of scope, however
attractive.

### P2. Never reintroduce the interrupt

The operator adopted autonomous modes to stop being interrupted. The board must not
require attention during execution. All comprehension work happens on return, from a
durable record. If the product only works when watched, it has failed.

The single exception is the deliberate gate at completion (P5), which is a
once-per-card event, not a per-tool one.

### P3. Synthesis, not volume

Raw events are the input, never the output. A card that displays 4,000 tool calls has
moved the reading burden rather than removing it. The default view is always the
synthesised brief; raw events are one click deeper, always available, never first.

Corollary: summarisation is a first-class function of the system and must be
budgeted, cached, and evaluated - not an afterthought bolted onto a log viewer.

### P4. Capture at the moment of loss

Information is cheapest to capture immediately before it is destroyed. `PreCompact` is
the archetype: the last instant at which pre-compaction context exists. `SubagentStop`
is another - a subagent's entire context window is discarded at that point, and only
its final message survives into the parent. Instrument the destruction points first.

### P5. Gates are enforced, not suggested

A review gate that relies on the operator choosing to review is the same as no gate.
Because `Stop`, `TaskCompleted`, and `SubagentStop` hooks block on exit code 2, the
board can make completion contingent on acknowledgement. Gates are configurable and
can be switched off per board, but when on they are real.

### P6. Local-first and offline-capable

All data lives on the operator's machine. The board runs as a single local process
with no account, no cloud dependency, and no telemetry. It reads a repository and a
directory of Claude Code state that already exist. This is a correctness requirement
as much as a privacy one: transcripts contain source code, credentials in shell
history, and internal architecture.

### P7. Degrade, do not break

Every dependency on an unstable surface (doc 02) must have a defined degraded mode.
If the transcript format changes, the utilization gauge goes blank and everything else
continues. If hooks are misconfigured, the board shows an explicit unbound state
rather than a silently empty card. The system announces what it cannot see.

### P8. The board is an artifact, not a UI

The record a card accumulates should be exportable as markdown and committable to the
repository. It must remain valuable when read six months later by someone who never
used the tool. This also protects against the product's own failure - the artifacts
survive it.

### P9. Zero-ceremony installation

`npx gorilla init` writes the hook configuration; `npx gorilla` starts the board. No
manual shell scripts, no per-event configuration, no environment variables the
operator must remember. Adoption friction is the primary failure mode of personal
tooling.

## Non-goals

**Multi-agent support.** No Codex, Gemini CLI, Cursor, or Copilot integration. The
strongest features - blocking gates, compaction capture, goal authoring - depend on
Claude Code-specific mechanisms. Genericising the integration layer would cost exactly
those features. This is a deliberate depth-over-breadth trade.

**Team collaboration.** Single operator, single machine. No auth, no roles, no shared
server, no realtime multiplayer. This may be revisited, but nothing in v1 should
assume it, because multi-tenancy would force the storage model away from local SQLite.

**Parallel agent orchestration at scale.** The board may bind several sessions, but
maximising concurrent agents is not the point (P1). Worktree isolation is a Phase 4
concern, not a founding requirement.

**A code review tool.** Diffs are summarised and linked, not reviewed in-app. The
operator's existing editor and `git diff` are better at this, and doc 03 argues the
diff is the wrong review target anyway.

**A general project management tool.** No sprints, no estimates, no burndown, no
velocity, no time tracking. The Kanban form is used because it maps cleanly onto
"a unit of agent work with a lifecycle", not because project management is wanted.

**Replacing the terminal.** The board dispatches work and holds the record; it does not
host the conversation. Planning happens in a Claude Code session, not in a web form
(doc 07 §2), and sessions the operator starts directly are observed and attributed
rather than treated as unsupported. Attached mode is therefore a permanent path, not a
migration step to be deprecated once launched mode works.

## The one-line test

Before any feature is built, it must answer this question affirmatively:

> Does this help me understand, in less time, what the agent did while I was not
> looking?

If the honest answer is "it helps the agent do more", it belongs in a different
product.
