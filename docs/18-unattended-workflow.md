# 18 - The Unattended Workflow

This document revises the roadmap around the workflow the operator actually
wants, which is narrower and more demanding than doc 16 assumed.

## The workflow

> Define tasks, run them, go to sleep. Wake up and every task is finished in its
> own worktree. Verify and merge what completed, with a reviewer agent whose
> only job is to merge the parallel worktrees into main and make sure nothing
> breaks.

Read plainly, that is four requirements, three of which the current build does
not meet.

| Requirement | Today |
| --- | --- |
| Tasks defined in a Claude Code conversation, landing on the board | Works |
| Dependencies declared and enforced before dispatch | Works |
| Many agents at once, one isolated worktree each | **Missing entirely** |
| Runs continue unattended for hours | **Broken: the queue halts on success** |
| Hard requirements - tests passing - actually enforced | **Missing: labelled hard, never run** |
| A summary of what each agent did, on waking | **Missing: mechanical ledger only** |
| A reviewer that merges the finished worktrees | **Missing** |

## What has to change, and why

### 1. Halting on success is wrong for unattended operation

The dispatcher currently halts after every completed run, on the argument that a
finished run is not a reviewed one and later cards may build on it (doc 16, P8).
That argument holds while the operator is present. It is exactly wrong for an
overnight queue: the operator would wake to one finished task and a queue that
never moved.

The resolution is that **isolation replaces serialisation**. The reason an
unreviewed completion was dangerous is that the next card built on it. Once each
card runs in its own worktree, that is no longer true - a later card cannot see
an earlier card's unmerged work unless it declared a dependency on it, in which
case the dependency graph already sequences them.

So: halt on failure, never on success. Completions accumulate in the review
column for the morning.

### 2. Isolation is not optional, and it is not Phase 4

Doc 16 deferred worktrees on the grounds that parallelism was not the point.
That was right about the product's purpose and wrong about this operator's
workflow. Several agents editing one checkout overwrite each other, which is why
concurrency currently defaults to one.

Each dispatched card gets a git worktree on its own branch. The card's session
runs there and nowhere else. Nothing merges automatically.

### 3. A hard guardrail must actually be hard

`verify` is stored, displayed as **hard**, and described to the operator as
"run by the board itself, so it does not depend on the agent reporting
honestly". Nothing runs it. It is folded into the goal condition text and left
to an evaluator that cannot execute commands.

That is the precise failure R10 exists to prevent, committed inside the code
that prevents it. A guardrail believed to be enforced but which is not is worse
than no guardrail, and this one is worse still because the interface asserts the
enforcement in as many words.

### 4. Waking up is a comprehension problem, which is the whole product

"A summary of what the agent did, to keep me in sync" is doc 08's brief, not the
mechanical ledger. The Phase 1 gate asked whether the mechanical version was
enough; the operator's answer is no, and that answer is the gate being passed
rather than skipped.

## The revised model

### Worktrees

Each dispatched card gets `.gorilla/worktrees/<card>/` on branch
`gorilla/<card-slug>`, created from the board's current HEAD.

- **Created** at dispatch, **kept** at completion. The work is the deliverable
  and must survive for review.
- **Removed** only when the operator merges or abandons the card. An unreviewed
  worktree is never cleaned up automatically: deleting an agent's night of work
  because a process restarted is unrecoverable.
- A card that fails still keeps its worktree, because the failure is usually
  what needs looking at.

Dependencies still sequence: a card whose dependency is unmerged branches from
that dependency's branch rather than from HEAD, so declared work composes and
undeclared work stays isolated.

### The verify gate

After a run completes, the board runs the card's `verify` command **in that
card's worktree** and records the exit code, output tail and duration.

- Passing is required to reach the terminal column while the gate is on.
- Failing moves the card to Needs Review with the output attached, not to Done.
- The result is a ledger entry either way, because "the tests passed" is
  something the operator should be able to see rather than infer.

This is the board checking, not the agent reporting, which is the entire
distinction the guardrail taxonomy is built on.

### The reviewer

A single-purpose agent, dispatched by the operator, never automatically. Its
brief is deliberately narrow:

1. Merge the named card branches into the integration branch, one at a time.
2. After each merge, run the project's verify command.
3. On conflict or failure, stop, leave the merge in place for inspection, and
   report which card broke and how.

It does not review code quality, does not touch cards the operator did not name,
and does not push. It exists so that "merge eleven overnight branches and tell
me if anything broke" is one action rather than an hour of the operator's
morning.

Its report is a ledger entry on each merged card, so the record of a merge lives
with the work it merged.

### Waking up

The resync digest (doc 09, screen 4) becomes the morning view: every card that
finished, what it changed, whether its verify passed, and what needs a decision -
ordered by significance rather than time.

## Revised task order

Ordered by what unblocks the workflow, not by architectural tidiness.

| | Task | Why here |
| --- | --- | --- |
| **U1** | Make `verify` real: run it in the worktree, gate on it, record it | Fixes a false claim; everything downstream trusts it |
| **U2** | Worktree per card, created at dispatch, kept for review | The blocker on running anything in parallel |
| **U3** | Parallel dispatch: raise concurrency, halt only on failure | Turns the board into something that can run overnight |
| **U4** | The reviewer agent and the merge flow | Turns a morning of merging into one action |
| **U5** | The brief: synthesis per card, "since you last looked" | The reason for waking up to a board rather than a diff |
| **U6** | Morning digest across cards | Where to look first when eleven things finished |

U1 to U4 make the night work. U5 and U6 make the morning worth having. Doc 16's
remaining Phase 2 items fold into U5.

## Being told the queue stopped

The gate only works if the operator finds out. A halt at 2am is
indistinguishable from a queue that ran all night, and the operator discovers it
at breakfast having lost six hours of unattended work - the same failure the
gate exists to prevent, moved from the review to the night.

`GORILLA_NOTIFY` names a command the board runs when a board's queue halts:
`notify-send`, `terminal-notifier`, a `curl` to a webhook. It is read from the
environment rather than the database, because a notification for an overnight
halt is worthless if it does not survive a restart.

The halt is never interpolated into that command. A card title is free text an
agent wrote, and pasting it into a shell string breaks on the first quote and
does something worse on the first `$(...)`. The facts arrive as environment
variables instead:

| Variable | What it holds |
| --- | --- |
| `GORILLA_BOARD` | The board's name |
| `GORILLA_HALT_REASON` | `failure`, `cancelled`, `awaiting-review`, `no-goal`, `stalled`, `unacknowledged-surprises` |
| `GORILLA_HALT_CARD` | The card's title |
| `GORILLA_HALT_CARD_ID` | The card's id |
| `GORILLA_HALT_DETAIL` | Why the queue stopped, in the operator's terms |
| `GORILLA_HALT_AT` | When, as an ISO timestamp |
| `GORILLA_HALT_MESSAGE` | All of the above as one line, for notifiers that want one argument |

The notification fires once per halt, on the halt that caused it: later failures
are consequences, and a notifier that repeated them would train the operator to
ignore the one that mattered. It is also fire-and-forget in both directions - the
queue never waits for it, and a notifier that fails, hangs or does not exist
never unhalts the board or breaks the gate. `gorilla doctor` warns when nothing
is configured.

## Being told the batch finished

`GORILLA_NOTIFY` fired when the queue halted, which is the bad news. An
operator waking to a finished batch got nothing at all - and from bed, a silent
board that finished and a silent board that never started are the same thing.

The same command now runs when the queue empties, with `GORILLA_EVENT` saying
which of the two happened so a notifier that only cares about failures can look
at one variable. The halt keeps every variable it had and gains that one.

Once per batch, not once per pump. A board polled while idle would otherwise
notify all night, and the flag clears the moment anything starts again so a
second batch is announced like the first.

Never for a board that has not done anything. Automatic mode switched on over
an empty column is not a finished batch, and announcing one at midnight is how
an operator learns to mute the notifier.

## Posting to something that is not a person

`GORILLA_NOTIFY` runs a command, which is right for waking somebody up and
wrong for everything else. A status page, a relay, or a second machine wanting
to know a card finished all want a request rather than a shell.

`GORILLA_WEBHOOK` names a url. The board posts JSON to it when a card settles
and when a queue halts. From the environment, like the notify command, because
a delivery configured only through the interface goes missing on the night it
matters.

What is sent is ids, a title, a status and a timestamp - never the card body,
the diff, the ledger, or anything a run said. This is a wire out of a process
that reads source code and transcripts, and the useful payload is "something
happened, come and look" rather than the thing itself.

Nothing waits for it. An unreachable endpoint is logged and forgotten: a board
that stopped working because a status page was down would be a worse product
than one with no webhook. `gorilla doctor` fails on a url that is not http or
https, because that is a webhook which silently never fires.

## Sharing one machine between boards

Concurrency is a board setting. Two boards set to three agents each is six
agents on one laptop, competing for the same cores, the same test runner and
the same rate limit - and neither board can see the other, so neither can be
blamed and nothing gets slower on purpose.

`GORILLA_MAX_AGENTS` caps the total, defaulting to four. It is read from the
lease table, which already knows what is in flight everywhere because that is
how a card is stopped from being dispatched twice.

The cap alone would not be fair. Whichever board woke first would take every
slot and the other would wait for it to finish, which is not starvation the
operator can see: both boards look like they are working. So while another
board holds a slot, no board may hold more than its share of the cap. A board
running on its own is unaffected, which is the common case and the one that
must not get slower for the sake of the other.

Shares round up. With a cap of three and two boards each gets two, because
rounding down would leave a slot nobody is allowed to take.

## Working only at night

"Define tasks, run them, go to sleep" has an unstated bound: the operator wants
the night, not the working day. A queue still dispatching at 09:30 competes
with them for the same checkout, the same test runner and the same rate limit.

A board can carry an hour range. Outside it the queue holds rather than halts.
A halt is sticky and asks for a person; a hold is a fact about the clock that
stops being true on its own, and a window needing a manual resume every morning
would be worse than no window.

A window that wraps midnight is the normal case here rather than an edge case,
since 22 to 07 is what overnight means. The same hour twice means always open:
a board configured 9 to 9 that silently never ran again would be
indistinguishable from a broken queue.

The queue wakes on a timer set for the opening, not by polling the clock. The
timer is unreferenced, so a board asleep until 22:00 is not a reason for
`gorilla serve` to refuse to exit.

The window governs the queue, not the operator. Dispatching one card by hand at
noon still works: someone pressing the button has said what they want.

## Trying again, but only where the evidence says to

A failure the run stated is not the same as a network having a bad minute, and
the CLI exits 1 for both. So the retry policy reads the CLI's stderr rather
than its exit code, and it is one-sided: a card is retried only where there is
positive evidence the cause was outside it - a named transient status, a
dropped connection, or a supervisor that could not watch the process at all.

Retrying unless something proves otherwise would rerun every card whose tests
genuinely fail, twice, every night. A missed retry costs one card; a wrong
retry costs every real failure the board ever sees.

Two attempts, not five. A transient fault that survives one retry is not
transient, and finding that out at attempt five costs three more runs' worth of
tokens than finding it out at attempt two.

Attempts are counted on the card, at the start of each run. In memory they
would be forgotten by a restart, and counted at the failure they would never
rise for a run killed with the board - either way a card that fails on every
start is retried indefinitely by a supervisor that keeps restarting it.

A retry does not count towards the failure streak above. An overloaded API is
not a card failing, and stopping the queue for a fault that resolved itself is
the thing both mechanisms exist to avoid.

## One card failing is not the night failing

The queue used to stop on any failure, on the argument that later work would
build on it. Worktrees removed that argument: an unmerged card is invisible to
the next one unless a dependency was declared, and declared dependencies
already sequence. What was left was one unfixable card stopping the whole
night, which is the failure this mode was written to prevent, arriving through
the other door.

Under the `unattended` policy a card that fails is blocked and the queue moves
on. Under `review` the queue still stops immediately, because someone is
watching and the next card would start on top of a problem they have not seen.

The escalation is the streak. One card failing is a card. Three in a row is not
a card any more - it is the checkout, the machine, the model, or the network -
and working through the remaining forty spends money to collect the same error
forty times. So three consecutive failures stop the queue, with a halt that
says it was a streak rather than repeating the last card's error message: "the
session exited with code 1" on the fourth card in a row invites the operator to
debug that card instead of the thing all four have in common.

The streak is on the dispatch state where the operator can see it. A threshold
nobody can see coming is experienced as the board stopping for no reason. It
resets when any card gets all the way through.

## Stopping a run that spends too much

A card can carry a token ceiling. It is set on the card, it defaults to none,
and it is enforced by the board rather than requested of the agent: crossing it
terminates the session. That makes it one of the few hard guardrails in the
system, and it is described as one everywhere it appears, because an operator
who reads it as advice will set it and then be surprised by a killed run.

Three things are worth knowing before setting one.

The count runs low. It is added up from the per-message usage as the stream
arrives, which is the only reading available while there is still something to
stop; the authoritative total only exists once the run has finished and the
money is spent. A ceiling therefore stops a run somewhat after it crossed the
line, never before. That is the right direction to be wrong in - the
alternative kills runs that had not actually overspent.

A stop for spending is not an abandonment. The card goes to blocked, its work
stays on its branch, and the halt names both the ceiling and what the run had
spent when it was stopped. An operator who can see only the limit cannot tell a
small overshoot from a runaway, and those call for different responses.

An operator's cancel is still reported as a cancel. Both stops are SIGTERM and
both come back from the launcher as `cancelled`, so the board records which one
it caused. Telling the operator a run overspent when they pressed cancel would
be a lie about what happened.

## Stopping the queue when the day is spent

The card ceiling stops one runaway run. It does nothing about the other shape
an overnight batch takes: fifty reasonable cards, none individually alarming,
and a bill in the morning. A board can therefore carry a daily token budget.
When the day's spend reaches it, the queue stops starting cards and halts with
a reason naming the card it declined to start.

Nothing in flight is touched. A run that is already going has work on its
branch worth more than the tokens it will spend finishing, and killing it would
leave the board paying for an unfinished job.

Tokens, not dollars. A price exists only for runs whose stream carried the
CLI's own total, so a budget in money would be enforced against a figure that
is present for some runs and missing for others. The board header shows today's
spend against the budget whether or not one is set, and marks the total with a
plus when some of today's runs recorded no usage - because then it is a lower
bound rather than a measurement.

The day is the operator's day. Spend is counted from local midnight; counting
in UTC would reset the budget in the middle of an evening's work.

## What this supersedes

- Doc 16's Phase 4 deferral of worktrees. They move to U2.
- Doc 16's P8 rule that a completed run halts the queue. Replaced by halt-on-
  failure once isolation makes it safe, per section 1.
- Doc 04's "parallel agent orchestration at scale" non-goal is narrowed rather
  than removed: the board still optimises for comprehension, and concurrency
  exists to let a night's work finish, not to maximise throughput.
