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

## What this supersedes

- Doc 16's Phase 4 deferral of worktrees. They move to U2.
- Doc 16's P8 rule that a completed run halts the queue. Replaced by halt-on-
  failure once isolation makes it safe, per section 1.
- Doc 04's "parallel agent orchestration at scale" non-goal is narrowed rather
  than removed: the board still optimises for comprehension, and concurrency
  exists to let a night's work finish, not to maximise throughput.
