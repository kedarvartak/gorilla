# 17 - Phase 1 Verification Report

Produced by P12 (doc 16). Claude Code **2.1.233**, Linux, 2026-08-16.

Every figure is a query result or a captured trace. Where something was not
measured, this report says so rather than substituting a plausible number.

## Verdict

**The loop works end to end. The gate's actual question is not yet answered.**

Phase 1's exit criterion is not "can the board dispatch a session" - it is
whether a ledger with no synthesis is already worth reading (doc 16). That is
the operator's judgement over real work, and one supervised run cannot settle
it. Everything mechanical that this run could exercise passed, and it did so
only after two real defects were found and fixed.

| Doc 10 / doc 16 criterion | Result |
| --- | --- |
| Plan a conversation, land cards with guardrails and models | Pass |
| Validation warnings surfaced per card | Pass |
| Dispatch runs unattended to completion | Pass, after two fixes |
| Every run correctly attributed | **Failed, fixed, re-verified** |
| Guardrail denials recorded | Pass |
| Mechanical ledger accurate | Pass on this run |
| Mechanical ledger *worth reading* | **Open - operator's judgement** |
| Automatic compaction observed | Open, carried from doc 15 |
| Six unexercised hooks | Open, carried from doc 15 |
| Long-run behaviour over an hour | Open |

## What was run

A scratch git project containing one file:

```python
def add(a, b):
    return a + b
```

Then, through the real API and a real Claude Code session:

1. A plan posted as `/gorilla:plan` would post it - two cards, one well
   specified, one deliberately vague, with a dependency between them.
2. The good card promoted to Ready and dispatched.
3. The run observed to completion, then the card, ledger and reality check read
   back.

## The plan intake worked first time

The vague card was flagged, per card, with remedies:

```json
{ "title": "Vague card", "warnings": [
    { "code": "no-verifiable-check",
      "message": "No check the evaluator could read. It does not run commands...",
      "remedy": "Name a command whose output will appear, such as \"`npm test` exits 0\"." },
    { "code": "no-bound",
      "message": "No turn or time bound, so this goal can run indefinitely.",
      "remedy": "Add a clause such as \"or stop after 20 turns\"." } ] }
```

with `next` reading *"Some cards have warnings. Fix them here, while the context
that produced them is still loaded, then re-post."* The dependency resolved by
title. Nothing was auto-promoted.

## Two defects, found only end to end

Both were invisible to the unit tests, because each component was correct in
isolation. This is the entire reason a verification task exists.

### 1. Launched binding was defeated by inferred binding

The dispatcher launched a session for card `83882ee6`. `SessionStart` fired,
saw a session with no card, and did the reasonable thing for a terminal session
- it created a provisional card and bound the run to that:

```
cards:  83882ee6  Add subtract to calc.py       awaiting-review
        b9f61b8e  Unclaimed session 9180ab9d    running
runs:   9180ab9d -> b9f61b8e
```

So the dispatched card showed **zero runs and an empty ledger** while reading
`awaiting-review`, and a phantom card sat at `running` forever. The board was
reporting completion with no evidence at all, which is doc 01's fourth failure
mode produced by the board itself.

The cause is an ordering assumption: `SessionStart` fires *before* the launcher
can read the session id from `system/init`, so at the moment the hook arrives
nothing knows which card the session belongs to.

**Fixed** by recording the expectation before the child starts
(`src/server/binding/pending.ts`). A launch the board is expecting takes
precedence over inference; inference remains the behaviour for a session the
board did not start.

### 2. A run that was refused everything reported as success

The card set no permission mode, so every tool call was denied. The agent tried,
was refused, gave up, and exited 0. The dispatcher marked the card
`awaiting-review`:

```
seq  event             tool
 3   PreToolUse        Edit
 4   Stop
 6   PreToolUse        Edit
 7   Stop
 9   PreToolUse        Edit
11   PreToolUse        Bash
12   PreToolUse        Bash
```

Five intents, zero outcomes, and a card that read as finished.

**Fixed** in two places. The launcher now defaults to `acceptEdits` when a card
chooses no permission mode, which is what doc 07 section 3 shows and what a
board dispatching unattended work means. And the dispatcher now checks whether a
completed run achieved anything: a run with tool intents and no outcomes halts
with reason `no-effect` and the detail *"finished without completing a single
tool call... which usually means they were denied"*, instead of reporting an
ordinary completion.

### A third problem, which was mine rather than the product's

The first attempt produced no events at all, because `gorilla init` defaults its
hook URLs to port 4300 while the server had been started on 4415. Nothing warns
about this. `doctor` diagnoses it correctly after the fact - it reports the
hooks as silent - but nothing prevents it, and a board that receives nothing
looks identical to a board with nothing to receive.

Not fixed here. Recorded as a follow-up: `serve` should warn when the project's
configured hook URLs do not point at the port it is listening on.

## The passing run

After both fixes, dispatching the same card:

```
status: awaiting-review

--- calc.py ---
def add(a, b):
    return a + b

def subtract(a, b):
    return a - b

--- verify command ---
subtract(5,3) = 2
```

Attribution, with no phantom card:

```
cards:  c5f9995f  Add subtract to calc.py  awaiting-review
runs:   66a1386c -> c5f9995f  (mode: launched)
```

The mechanical ledger, from 29 events:

```
change  .../calc.py was modified (1 edit)                        (sources: 1)
risk    Bash was attempted 8 time(s) with no outcome recorded    (sources: 8)

reality:
  1 file(s) changed according to git.
  The event stream and the repository agree.
```

Both entries are worth reading, and the second is the interesting one. Under
`acceptEdits` the agent may edit files but not run arbitrary shell commands, so
its eight attempts to verify its own work were refused - and **no event reports
that**. The ledger surfaced it only because it counts intents without outcomes,
which was built from the doc 15 finding. Without it the run would look entirely
clean.

That is the mechanism working exactly as intended, on real data, unprompted.

## What remains open

**Whether the ledger is worth reading.** Two entries from one small run is not
evidence. The gate is the operator's judgement across real work, and it should
be taken after a week of ordinary use, not after a demonstration.

**Automatic compaction**, carried from doc 15. This run was too short to compact.

**Six hooks still unexercised**: `Notification`, `PostToolUseFailure`,
`StopFailure`, `TaskCreated`, `TaskCompleted`, `SubagentStart` in a launched
session.

**Long-run behaviour.** Nothing here says anything about an hour: database
growth, memory, or whether the SSE stream stays healthy.

**Concurrency above one.** The pending-binding queue is keyed by working
directory and consumed in order, which is unambiguous while dispatch is serial.
With two sessions starting at once in the same directory, an interleaving could
attribute a run to the wrong card. Serial is the default and the queue is
FIFO, so this is a known limit rather than a live defect - but it should be
closed before concurrency is raised.

## Recommendation

Phase 1's mechanics are sound. Before Phase 2 begins, use the board for a week
of ordinary work and answer the one question that matters: reading only the
mechanical ledger, do you learn something you would otherwise have missed?

If yes, Phase 2 has a floor to build on. If no, doc 16 is explicit that Phase 2
should be re-planned rather than started, because the extraction pipeline will
not rescue a record nobody wants to read.
