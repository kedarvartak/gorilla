# Gorilla

A local-first Kanban board for driving Claude Code in autonomous modes without losing
track of what is being built.

Autonomous modes remove the interruptions that used to keep you informed: auto mode
removes the per-tool prompt, `/goal` removes the per-turn prompt. The work continues;
your model of the work does not. Gorilla binds each card to a real Claude Code session
and accumulates a durable, readable record of what the agent did, decided, assumed,
changed, and forgot - so that returning to a card after an unattended run takes two
minutes rather than a transcript read you will not do.

Status: design complete, no implementation. See [docs/00-overview.md](docs/00-overview.md).
