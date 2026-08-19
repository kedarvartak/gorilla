# Gorilla

A local-first Kanban board for driving Claude Code in autonomous modes without losing
track of what is being built.

Autonomous modes remove the interruptions that used to keep you informed: auto mode
removes the per-tool prompt, `/goal` removes the per-turn prompt. The work continues;
your model of the work does not. Gorilla binds each card to a real Claude Code session
and accumulates a durable, readable record of what the agent did, decided, assumed,
changed, and forgot - so that returning to a card after an unattended run takes two
minutes rather than a transcript read you will not do.

## Where it is

Working, and used to build itself: fourteen of its own cards have been dispatched to
agents and merged through the board. It is not packaged or published, and several
paths have passing tests but have never run in anger - which
[docs/19-status.md](docs/19-status.md) lists separately, because "the tests pass" and
"this has worked once for real" are different claims.

Start with [docs/00-overview.md](docs/00-overview.md) for what it is for, or
[docs/19-status.md](docs/19-status.md) for what exists today.

## Using it

```bash
npm install && npm run build
node dist/cli/index.js init     # write hook configuration into this project
node dist/cli/index.js serve    # the board, at http://127.0.0.1:4300
```

`init` registers the hooks that let the board see a session; `serve` runs the board and
creates one for the directory it starts in. `doctor` reports what the board cannot see.

Plan work in a Claude Code conversation and post it with `/gorilla:plan`; bind a session
to a card with `/gorilla:claim`. Synthesis runs through the Claude Code CLI on the quota
you already have - no API key, and none is asked for.
