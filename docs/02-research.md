# 02 - Research: Available Integration Surfaces

All findings below were verified against the official Claude Code documentation
(August 2026) or against local files on this machine. Stability of each surface is
graded, because several are experimental and the architecture must not depend on
unstable ones for core function.

## Surface A: Hooks (stable, primary)

Claude Code fires user-configured hooks at approximately thirty lifecycle points.
Every hook receives JSON on stdin (or as an HTTP POST body) and every payload carries
the common fields `session_id`, `hook_event_name`, `transcript_path`, `cwd`, and
`permission_mode`.

Events relevant to this product:

| Event | Payload additions | Why it matters here |
| --- | --- | --- |
| `SessionStart` | `permission_mode`, `model`; matcher on `startup`/`resume`/`clear`/`compact`/`fork` | Bind a session to a card; inject the card brief as context |
| `UserPromptSubmit` | `user_input`, `prompt_id` | Record operator intent verbatim |
| `PreToolUse` | `tool_name`, `tool_input`, `tool_use_id`, `effort` | Intent before action |
| `PostToolUse` | `tool_response` | What actually changed; source of the diff digest |
| `PostToolUseFailure` | `tool_error` | Failure and recovery narrative |
| `PreCompact` | `trigger_reason` (`manual`/`auto`) | **Highest-value event.** Fires before context is discarded |
| `PostCompact` | - | Marks the discontinuity on the card timeline |
| `SubagentStart` / `SubagentStop` | `agent_type`, `agent_id`, `last_assistant_message` | Work done in context windows the operator never sees at all |
| `TaskCreated` / `TaskCompleted` | `task_name`, `task_description`, `task_id` | Bidirectional sync with Claude's own task list |
| `Stop` | `last_assistant_message` | End of turn; the natural point to update a card |
| `StopFailure` | `error_type` | Distinguishes "finished" from "died on a rate limit" |
| `Notification` | `notification_type` (incl. `permission_prompt`, `idle_prompt`) | Card needs human attention |
| `SessionEnd` | `end_reason` | Close out the binding |

Two properties of hooks are architecturally decisive:

**1. HTTP transport.** A hook may be declared as
`{"type": "http", "url": "http://localhost:4300/hooks/<event>"}`. The response body
uses the same JSON schema as a command hook's stdout. This means the board server
receives events directly, with no shell scripts on disk, no `jq`, and no per-machine
scripting. Installation reduces to writing one settings file.

**2. Blocking semantics.** Exit code 2 (or, for HTTP hooks, an equivalent JSON
decision) blocks the action for a specific subset of events. Confirmed blockable:
`PreToolUse`, `UserPromptSubmit`, `Stop`, `SubagentStop`, `TaskCreated`,
`TaskCompleted`, `PreCompact`, `PostToolBatch`. This is what makes a review gate real
rather than advisory. `PostToolUse` cannot block - the tool has already run.

Hooks may also be declared `async: true` to run in the background, and
`asyncRewake: true` to wake the session when they finish with exit code 2.

## Surface B: The transcript file (unstable, secondary)

Located at `~/.claude/projects/<cwd-slug>/<session-id>.jsonl`, where the slug is the
working directory path with non-alphanumeric characters replaced by hyphens. The
`transcript_path` is handed to us in every hook payload, so we never need to compute
the slug ourselves.

Verified locally, the file contains newline-delimited records with a `type` field. The
observed types and their useful fields:

- `user` - `message`, `cwd`, `gitBranch`, `promptId`, `toolUseResult`, `timestamp`, `uuid`, `parentUuid`
- `assistant` - `message` (with `content` blocks: `text`, `thinking`, `tool_use`), `message.usage`, `effort`, `requestId`
- `attachment` - injected context
- `file-history-snapshot` - `snapshot`, `messageId`
- `ai-title` - the model's own name for the session
- `last-prompt`, `mode`, `permission-mode` - session state markers

`message.usage` was confirmed to include `input_tokens`,
`cache_read_input_tokens`, `cache_creation_input_tokens`, `output_tokens`, and a
`thinking_tokens` breakdown. Summing these against the model's window yields a real
context-utilization figure - the input to the utilization gauge in doc 08.

**Stability caveat, stated explicitly in the official docs:** this format is internal
to Claude Code and changes between versions. Parsers that depend on it break on
release. Design consequence: the transcript is a *enrichment* source only. Every core
feature must degrade gracefully to hooks-only. The parser is isolated behind one
module with a schema-drift detector that logs unknown record types rather than
throwing.

## Surface C: Programmatic launch (stable)

`claude -p` runs non-interactively. Relevant flags:

- `--output-format stream-json --verbose` emits each message as an event as the run
  proceeds. `--include-partial-messages` adds token deltas.
- The first event is `system/init`, carrying session metadata: model, tools, MCP
  servers, plugins.
- `system/api_retry` events report retryable failures with attempt counts.
- Subagent messages appear with `parent_tool_use_id` set to the spawning tool call;
  `--forward-subagent-text` includes their text and thinking blocks, so a full
  subagent transcript can be reconstructed.
- `--resume <session-id>` continues a specific session; as of v2.1.223 the session is
  found by ID from any directory.
- `/goal` works under `-p`: `claude -p "/goal <condition>"` runs the loop to
  completion in one invocation.
- SIGTERM aborts the turn, runs `SessionEnd` hooks, exits 143 - so clean cancellation
  from the board is possible.

## Surface D: `/goal` semantics (stable)

Confirmed mechanics, which constrain how the board should author goals:

- One goal per session; setting a goal starts a turn immediately.
- After every turn, the configured small fast model (Haiku by default) receives the
  condition and the conversation and returns `met`, `not yet met`, or `impossible`,
  each with a reason. The reason is shown in the transcript and status view.
- **The evaluator does not call tools.** It cannot run commands or read files. It can
  only judge what the agent has already surfaced in the conversation.
- Conditions are capped at 4,000 characters.
- If the agent answers the evaluator without using tools for several turns, the loop
  halts with a warning and returns control.
- A goal active at session end is restored on `--resume`; counters reset.
- `/goal` is unavailable when hooks are disabled, because it is implemented as a
  session-scoped prompt-based Stop hook.

The tool-blindness of the evaluator is the important one. A condition like "the tests
pass" only resolves if the agent ran the tests and the output landed in the
transcript. The board should therefore help author conditions in the form
*measurable end state + stated check + constraints*, and should warn on conditions
with no stated check.

## Surface E: Claude's own task list (experimental, do not depend on)

Agent teams (gated behind `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`) maintain a shared
task list with three states - pending, in progress, completed - plus dependencies,
persisted under `~/.claude/tasks/{team-name}/`, with claiming protected by file
locking. Verified on this machine: directories exist keyed by session UUID, containing
`.lock` and `.highwatermark`; task JSON files are transient and had been cleaned up.

The `TaskCreated` and `TaskCompleted` hooks fire regardless and carry `task_name`,
`task_description`, and `task_id`. Design consequence: consume the hook events (stable
enough, and they are the ones that can block), and treat the on-disk files as a
read-only curiosity, never a source of truth.

## Surface F: Channels (research preview, out of scope for v1)

Channels let an MCP server push events into a running session, and can relay
permission prompts to a remote surface. This is the natural mechanism for the board to
push a message into a live session - "the operator has left a comment on this card."
It is explicitly a research preview with a protocol contract that may change, requires
plugin allowlisting, and is unavailable on some providers. Noted as the intended
Phase 4 mechanism; not a v1 dependency. The v1 fallback for board-to-agent messaging
is `claude -p --resume <session-id>`.

## Surface G: Git (stable)

Independent of Claude Code entirely. Branch, diff, and commit history give an
authoritative account of what actually changed, against which agent claims can be
checked. `gitBranch` appears in transcript records, and worktrees (`--worktree`, with
`WorktreeCreate`/`WorktreeRemove` hooks) provide per-card isolation if parallel cards
are ever supported.

## Summary of dependency grades

| Surface | Grade | Core feature may depend on it |
| --- | --- | --- |
| Hooks (HTTP) | Stable, documented | Yes - primary |
| `claude -p` / stream-json | Stable, documented | Yes |
| Git | Stable | Yes |
| `/goal` | Stable, documented | Yes |
| Transcript JSONL | Internal, version-fragile | No - enrichment only |
| Task list files | Experimental | No |
| Channels | Research preview | No |

## Sources

- [Hooks reference](https://code.claude.com/docs/en/hooks)
- [Run Claude Code programmatically](https://code.claude.com/docs/en/headless)
- [Keep Claude working toward a goal](https://code.claude.com/docs/en/goal)
- [Orchestrate teams of Claude Code sessions](https://code.claude.com/docs/en/agent-teams)
- [Push events into a running session with channels](https://code.claude.com/docs/en/channels)
- [Manage sessions](https://code.claude.com/docs/en/sessions)
- [Effective context engineering for AI agents, Anthropic](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- [Advanced Context Engineering for Coding Agents, HumanLayer](https://github.com/humanlayer/advanced-context-engineering-for-coding-agents/blob/main/ace-fca.md)
- [Context Engineering for Coding Agents, Martin Fowler](https://martinfowler.com/articles/exploring-gen-ai/context-engineering-coding-agents.html)
