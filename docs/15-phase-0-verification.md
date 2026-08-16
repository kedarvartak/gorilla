# 15 - Phase 0 Verification Report

Produced by T10 (doc 13). Claude Code **2.1.233**, Linux, 2026-08-16.

Every figure is a query result or a captured trace. Nothing is estimated. Where
something was not measured, this report says so instead of substituting a
plausible number - the failure mode of a self-written verification report is
that it reads as though everything went well.

## Verdict

**Phase 0 passes on every criterion that this run could exercise, with one
criterion left open that requires the operator.**

The headline result is that doc 12's compaction repair is viable exactly as
specified. That was the open question from doc 14, and it is now closed
affirmatively.

| Doc 10 exit criterion | Result |
| --- | --- |
| Every configured event is received | Partially. 9 of 15 fired; the 6 that did not need conditions this run never reached. See below |
| Events are ordered | Pass. Dense, monotonic, duplicate-free |
| Events are persisted | Pass. 21 events, 1 run, 1 board |
| No measurable slowdown of the agent | **Open.** Requires the operator's judgement over a long session |
| `PreCompact` fires, transcript readable | Pass, confirmed in T9 and again here |
| `SessionStart` fires with `compact` | **Pass.** Observed directly, see the trace |
| Injected text reaches the model | Pass, confirmed in T9 with a nonce |
| Any hook that never fired is named | Pass, named below |

## What was run

A real Claude Code session against a running board, with real tool use: it wrote
`fizz.py` and `test_fizz.py`, and attempted to run them. Then `/compact` on the
resumed session, then a further turn after the compaction.

Hooks were installed as doc 07 specifies, with one change forced by doc 14:
`SessionStart` is registered as a **command hook bridging to the board over
HTTP**, because HTTP hooks do not receive `SessionStart`. Every other event is a
plain HTTP hook.

**This was not the forty-minute session doc 13 asks for**, and the compaction was
manual rather than automatic. What that costs is stated under "What remains
open".

## The trace

The full ordered event sequence, exactly as recorded:

```
 1 SessionStart       source=startup
 2 UserPromptSubmit
 3 PreToolUse         tool=Write
 4 PostToolUse        tool=Write
 5 PreToolUse         tool=Write
 6 PostToolUse        tool=Write
 7 PreToolUse         tool=Bash
 8 PreToolUse         tool=Bash
 9 PreToolUse         tool=Bash
10 Stop
11 SessionEnd
12 SessionStart       source=resume
13 PreCompact
14 SubagentStop
15 SessionStart       source=compact
16 PostCompact
17 SessionEnd
18 SessionStart       source=resume
19 UserPromptSubmit
20 Stop
21 SessionEnd
```

### The compaction sequence is the important part

```
13 PreCompact
15 SessionStart source=compact
16 PostCompact
```

This closes doc 14's open question. `SessionStart` **does** fire with source
`compact`, and it fires *before* `PostCompact`. Combined with T9's confirmed
findings - that `PreCompact` exposes a readable transcript tail, and that
`additionalContext` returned from a `SessionStart` hook reaches the model - the
full doc 12 repair loop is now demonstrated end to end:

1. `PreCompact` fires; the window about to be discarded is readable.
2. Compaction happens.
3. `SessionStart` fires with source `compact`.
4. Text returned from that hook reaches the model.

Doc 14 could not see step 3 because it registered `SessionStart` as an HTTP
hook. The bridge is what made it visible, which is a second confirmation of that
finding rather than a contradiction of it.

## Events received

Total **21**, across 1 run and 1 board.

| Event | Count |
| --- | --- |
| `PreToolUse` | 5 |
| `SessionStart` | 4 |
| `SessionEnd` | 3 |
| `PostToolUse` | 2 |
| `Stop` | 2 |
| `UserPromptSubmit` | 2 |
| `PreCompact` | 1 |
| `PostCompact` | 1 |
| `SubagentStop` | 1 |

## Hooks that never fired

- `Notification` - no permission prompt or idle prompt occurred.
- `PostToolUseFailure` - no tool raised an error.
- `StopFailure` - no API failure occurred.
- `TaskCreated`, `TaskCompleted` - the agent used no task tools.
- `SubagentStart` - **see below. This one is a finding, not an absence.**

The first five are explained by the session simply not reaching those
conditions. They are not evidence of a problem, and equally they are not
evidence that those hooks work. A longer session is needed to exercise them.

## Two anomalies worth recording

### `SubagentStart` did not fire, but `SubagentStop` did

Event 14 is a `SubagentStop` with no matching `SubagentStart`. Both are
registered as HTTP hooks in this run.

This is the same shape as doc 14's `SessionStart` finding: a `*Start` event
missing over HTTP while its `*Stop` counterpart arrives. Two observations is a
pattern worth testing, not a conclusion - doc 14's follow-up 4 already proposes
extending the probe to every registered event, and this raises its priority.

If it holds, doc 07 needs the bridge for `SubagentStart` too, and the board would
otherwise never learn that a subagent had begun - work happening in a context
window the operator never sees, which is precisely what doc 04's P4 says to
instrument.

### Five `PreToolUse` against two `PostToolUse`

Events 7, 8 and 9 are `Bash` calls with no corresponding `PostToolUse` and no
`PostToolUseFailure`. The run used `--permission-mode acceptEdits`, which
auto-approves file edits but not arbitrary shell commands, so the most likely
explanation is that those three calls were denied.

Gorilla does not currently register `PermissionRequest` or `PermissionDenied`, so
a denial is invisible to the board: it sees an intent with no outcome. For a
product whose purpose is to explain what the agent did, "tried three times and
was refused" is exactly the kind of thing that should reach the operator.

**Recommendation:** add `PermissionDenied` to doc 07's registered set in Phase 1.
It maps directly onto a ledger `risk` entry.

## Ingest latency

Read from the running server over 21 real events:

| p50 | p95 | p99 | max |
| --- | --- | --- | --- |
| 0.31 ms | 0.62 ms | 3.81 ms | 3.81 ms |

Inside doc 06's 25 ms p99 budget by a wide margin, and consistent with the
synthetic benchmark in T3 (p50 0.11 ms, p99 3.87 ms over 1,000 events). This is
the measurement CI could not make, since the budget is about the operator's
machine rather than a shared runner.

Twenty-one samples is a small number. The figure is reported as what it is.

## Ordering

Intact. The single run's sequence numbers are 1 to 21, dense, monotonic and
duplicate-free, confirming the per-run counter in T3 holds under real
interleaving including a subagent and a compaction.

## What remains open

**The operator's judgement on slowdown.** Doc 13 states plainly that this is not
an autonomous task: whether the agent *felt* slower is not something the harness
can answer, and 21 events at sub-millisecond p50 is evidence but not the same
thing. This needs a real working session.

**Automatic compaction.** The compaction here was triggered with `/compact`. The
`SessionStart source=compact` result is strong evidence the auto path behaves the
same way, since the same event fired with the same source value, but it has not
been observed after an auto-compaction specifically.

**Six hooks unexercised.** Named above. They need a session that fails a tool,
hits a permission prompt, or uses the task tools.

**Long-run behaviour.** Nothing here says anything about a forty-minute session:
database growth, memory, or whether the SSE stream stays healthy for an hour.

## Recommendation for Phase 1

Phase 0's purpose was to prove the pipe and de-risk compaction. Both are done,
and the compaction result is better than expected - the mechanism doc 12's most
valuable feature depends on is confirmed working end to end.

Three changes should land at the start of Phase 1:

1. **Bridge `SessionStart`** in `gorilla init`, per doc 14.
2. **Test whether `SubagentStart` needs the same bridge**, and bridge it if so.
3. **Register `PermissionDenied`**, so denials are visible rather than appearing
   as intents with no outcome.

## Reproducing

```
gorilla serve --port 4405 &          # with GORILLA_DB_PATH set
# run a Claude Code session in a project configured per doc 07
gorilla report --db <path> --port 4405
```

Latency can only be read while the server that received the events is still
running, because it is held in the process. Generate the report before stopping
the server.
