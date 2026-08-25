<div align="center"><pre>
 ██████╗  ██████╗ ██████╗ ██╗██╗     ██╗      █████╗
██╔════╝ ██╔═══██╗██╔══██╗██║██║     ██║     ██╔══██╗
██║  ███╗██║   ██║██████╔╝██║██║     ██║     ███████║
██║   ██║██║   ██║██╔══██╗██║██║     ██║     ██╔══██║
╚██████╔╝╚██████╔╝██║  ██║██║███████╗███████╗██║  ██║
 ╚═════╝  ╚═════╝ ╚═╝  ╚═╝╚═╝╚══════╝╚══════╝╚═╝  ╚═╝
</pre></div>

**A local-first Kanban board for understanding autonomous Claude Code work.**

Gorilla helps you run Claude Code sessions unattended without losing track of what
is being built. Each card is connected to a real Claude Code session and keeps a
durable record of its changes, decisions, assumptions, risks, questions, and
verification results.

It is not primarily an agent-orchestration tool. Orchestrators optimize for running
more agents in parallel; Gorilla optimizes for **human comprehension**. When you
return to a project, the board gives you a concise brief of what happened and what
needs your judgement instead of requiring you to reread a long transcript.

## How it works

1. Create cards describing the work and its definition of done.
2. Dispatch cards to Claude Code sessions in isolated Git worktrees.
3. Gorilla observes hooks, transcripts, tool activity, and Git changes.
4. It builds a mechanical and model-assisted ledger for each card.
5. Review the result, verify the work, and accept, correct, retry, or block it.

The board can run manually or unattended, with review gates, dependencies, budgets,
retries, dispatch windows, stall detection, notifications, and live updates. It runs
locally using SQLite and does not require a hosted service or separate API key when
using the Claude Code CLI.

## Run it

```
npm install
npm run build
node dist/cli/index.js init
node dist/cli/index.js serve
```

Open **http://127.0.0.1:4300**.

`init` installs the Claude Code hooks for the current project. `serve` starts the
local board. Planning and claiming can be done from Claude Code with
`/gorilla:plan` and `/gorilla:claim`.

## Development

```bash
npm run dev       # development server
npm run test      # build and run tests
npm run typecheck
npm run lint
```

Gorilla is intentionally local-first and Claude Code-specific: its strongest
features depend on Claude Code hooks, transcripts, compaction events, and the CLI.
