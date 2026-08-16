# 03 - Prior Art and Positioning

## Vibe Kanban (BloopAI)

The closest existing product. Open-source, web-based, presents a Kanban board where
each task is dispatched to a coding agent - Claude Code, Codex, Gemini CLI, Copilot,
Amp, Cursor and others. Each task runs in its own git worktree for isolation. Diffs
are reviewed in-app with syntax highlighting before merge.

Two observations:

1. **It is an orchestrator.** The board is a dispatch queue. Its value proposition is
   parallelism - running many agents at once without collision. The review surface is
   the diff, presented at the end.
2. **It is being sunset.** The product is transitioning to community-maintained open
   source. Whatever the commercial reason, the category is not settled.

The gap: a diff tells you what the text of the repository became. It does not tell you
what was decided, what was assumed, what was tried and rejected, or what the agent
knew at the moment it made a choice and has since forgotten. Reviewing a 2,000-line
agent-authored diff is precisely the activity that does not scale, and it is the
activity Vibe Kanban's review surface centres on.

## Hook-based observability dashboards

`disler/claude-code-hooks-multi-agent-observability` and `simple10/agents-observe` both
sit between the hook system and a browser, rendering PreToolUse/PostToolUse/lifecycle
events into a filterable, searchable, replayable event stream.

These prove the ingestion mechanism works and is performant. They are, however, event
viewers: the unit of presentation is the event, ordered by time. This is the correct
tool for debugging an agent and the wrong tool for regaining a mental model, because
it presents raw volume rather than synthesis. Reading 4,000 events is not faster than
reading the transcript.

Gorilla borrows their ingestion architecture wholesale and rejects their presentation
model. The unit of presentation must be the *task*, and the content must be
*synthesised*, not raw.

## Claude Code's own surfaces

- **Agent view** dispatches and monitors many sessions from one screen, showing what
  each is doing and which need input. It is session-oriented and ephemeral - it
  answers "what is happening now", not "what happened while I was away".
- **The shared task list** in agent teams tracks pending/in-progress/completed with
  dependencies, but is scoped to a single session's team, is experimental, and carries
  no context beyond a name and description.
- **Auto memory and CLAUDE.md** persist knowledge into future *agent* context. They are
  designed for the model to read, not for the operator to review. Nothing in them
  records what happened during a specific run.

None of these is a durable, per-task, operator-facing record. That is the hole.

## The context engineering literature

Two sources shape the design directly.

**Anthropic, "Effective context engineering for AI agents."** Context is a finite
resource subject to "context rot" - retrieval precision and long-range reasoning
degrade measurably as the window fills, and this is a gradient, not a cliff. The
recommended countermeasures are compaction, structured note-taking to external memory,
sub-agent architectures returning condensed summaries, and just-in-time retrieval.

The relevant inference: if external memory is the accepted remedy for the *agent's*
context limits, then the same artifact, written once, can serve the *operator's*
context limits. The operator is also a stateless processor being handed a window.

**HumanLayer, "Advanced Context Engineering for Coding Agents" (ACE-FCA).** Argues for
frequent intentional compaction - deliberately pausing to synthesise progress into
structured artifacts before starting a fresh context window - holding utilization
between 40 and 60 percent. It structures work as research, then plan, then implement,
and makes a specific claim about review:

> Technical experts should scrutinise research and plans rather than generated code.

The justification is asymmetry of consequence: a bad line in a plan produces hundreds
of bad lines of code. The artifacts recommended for life outside the agent's context
are progress files, research summaries, implementation plans with verification
criteria, and commit messages used as compaction checkpoints.

The author's stated primary goal is not speed but "mental alignment" - keeping
everyone informed through specifications and plans rather than code diffs. That is the
same objective this product has, and ACE-FCA achieves it through manual discipline
with markdown files. Gorilla's thesis is that this discipline can be captured
automatically from the event stream, at the moment it matters, rather than depending
on the operator remembering to write it down.

## Positioning statement

| Dimension | Vibe Kanban | Hook dashboards | ACE-FCA practice | Gorilla |
| --- | --- | --- | --- | --- |
| Optimises for | Agent throughput | Debuggability | Correctness via discipline | Operator comprehension |
| Unit of presentation | Task, reviewed as diff | Event, ordered by time | Markdown artifact | Task, presented as brief |
| Artifact lifetime | Until merge | Session | Committed to repo | Permanent, indexed, per card |
| Requires operator discipline | Low | Low | High | None |
| Review target | Generated code | Raw events | Research and plans | Decisions and assumptions |
| Enforces review | No | No | By convention | Yes, via blocking hooks |

The last row is the one no prior art has. Because `Stop` and `TaskCompleted` hooks can
block on exit code 2, a board-defined review gate is enforced by Claude Code itself
rather than by the operator's good intentions. This is the structural advantage
available to a tool built specifically against Claude Code, and it is the reason to
build against Claude Code exclusively rather than pursuing multi-agent support.

## Sources

- [Vibe Kanban](https://www.vibekanban.com/) and [BloopAI/vibe-kanban](https://github.com/BloopAI/vibe-kanban)
- [disler/claude-code-hooks-multi-agent-observability](https://github.com/disler/claude-code-hooks-multi-agent-observability)
- [simple10/agents-observe](https://github.com/simple10/agents-observe)
- [Manage multiple agents with agent view](https://code.claude.com/docs/en/agent-view)
- [Effective context engineering for AI agents, Anthropic](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- [ACE-FCA, HumanLayer](https://github.com/humanlayer/advanced-context-engineering-for-coding-agents/blob/main/ace-fca.md)
