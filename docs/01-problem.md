# 01 - Problem Statement

## The observation

Autonomous modes in Claude Code (`/goal` combined with auto mode) remove the two
interruption points that previously kept the operator informed:

1. Auto mode removes the per-tool approval prompt.
2. `/goal` removes the per-turn prompt, because a separate evaluator decides whether
   to start another turn.

Both removals are individually desirable. Together they eliminate every natural
checkpoint at which the operator was previously forced to look at what was happening.
The work continues; the operator's model of the work does not.

## Naming the failure

The user's framing is inattentional blindness - the invisible gorilla. An observer
given a counting task fails to notice an obvious, unexpected event in plain view.
The mechanism is not poor eyesight. It is that attention was allocated elsewhere.

The agent-assisted equivalent: the operator's attention is allocated to outcomes
(does it build, does the test pass, is the feature there) while the substance of the
work - which files were restructured, which dependency was added, which assumption was
made about the schema, which alternative was rejected and why - passes through
unobserved. It is visible in the transcript. It is simply never attended to.

This is distinct from, and worse than, not having the information. The information is
present and skippable, which makes skipping it feel safe.

## The compounding factor: compaction

Long autonomous runs exceed the context window and trigger compaction. Compaction is
lossy in a way that is not deterministic: the summary preserves what the summarizing
model judged important. Subtle constraints whose importance emerges later are the
first things dropped.

The consequence is a divergence with two sides:

- **The agent forgets.** After compaction it operates on a summary, and may
  re-litigate a decision it already made, or violate a constraint stated 200 turns ago.
- **The operator never knew.** The pre-compaction detail was the operator's only
  chance to see that constraint stated, and it is now gone from both parties.

Compaction is therefore the single highest-value capture point in the entire system.
The moment before context is discarded is the moment its contents are most worth
persisting somewhere durable.

## Observable failure modes

These are the symptoms the product must eliminate, in priority order:

1. **Silent architectural drift.** A structural decision is made mid-run and never
   surfaced. It is discovered weeks later, when changing it is expensive.
2. **Re-explanation cost.** The operator must re-read a long transcript, or re-ask the
   agent, to answer "what is the current state of this?" The cost of this is high
   enough that it is usually skipped, which is how drift accumulates.
3. **Untraceable change.** A file changed and there is no cheap way to learn which
   task caused it or what reasoning justified it.
4. **False completion.** A card reads Done because the agent said so. The evaluator
   judged the goal condition met based only on what the agent surfaced, which is not
   the same as the work being correct.
5. **Constraint loss across compaction.** Described above.

## What good looks like

Concrete acceptance criteria for the product, expressed as operator experience:

- After any unattended run of any length, a single screen answers: what changed, what
  was decided, what is now assumed, and what needs a human judgement - in under two
  minutes of reading.
- No card reaches Done without the operator having seen that screen.
- Every decision the agent made survives compaction, session end, and machine restart.
- Nothing about this requires the operator to have been watching.

## What this is not

It is not a supervision tool that reintroduces approval prompts. Reinstating
interruptions would defeat the reason autonomous modes are used. The design
constraint is: **preserve full autonomy during execution, guarantee comprehension
after it.**
