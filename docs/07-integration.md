# 07 - Integration Contract with Claude Code

This document specifies the exact mechanical contract. Every claim traces to a
verified surface in doc 02.

## 1. Installation

`npx gorilla init` writes to the project's `.claude/settings.local.json` (gitignored by
default, since the board is a personal instrument), merging rather than replacing any
existing hook configuration. It never touches `.claude/settings.json` unless asked with
`--shared`.

The configuration registers hooks pointing at the local board. Most are HTTP; one is
bridged through a command hook, for the reason given below the table:

```json
{
  "hooks": {
    "SessionStart":   [{ "hooks": [{ "type": "command", "command": "${CLAUDE_PROJECT_DIR}/.claude/gorilla-bridge.sh SessionStart" }] }],
    "UserPromptSubmit":[{ "hooks": [{ "type": "http", "url": "http://127.0.0.1:4300/hooks/UserPromptSubmit" }] }],
    "PreToolUse":     [{ "matcher": "Edit|Write|NotebookEdit|Bash", "hooks": [{ "type": "http", "url": "http://127.0.0.1:4300/hooks/PreToolUse" }] }],
    "PostToolUse":    [{ "matcher": "Edit|Write|NotebookEdit|Bash", "hooks": [{ "type": "http", "url": "http://127.0.0.1:4300/hooks/PostToolUse" }] }],
    "PostToolUseFailure": [{ "hooks": [{ "type": "http", "url": "http://127.0.0.1:4300/hooks/PostToolUseFailure" }] }],
    "PreCompact":     [{ "hooks": [{ "type": "http", "url": "http://127.0.0.1:4300/hooks/PreCompact", "timeout": 120 }] }],
    "PostCompact":    [{ "hooks": [{ "type": "http", "url": "http://127.0.0.1:4300/hooks/PostCompact" }] }],
    "SubagentStart":  [{ "hooks": [{ "type": "http", "url": "http://127.0.0.1:4300/hooks/SubagentStart" }] }],
    "SubagentStop":   [{ "hooks": [{ "type": "http", "url": "http://127.0.0.1:4300/hooks/SubagentStop" }] }],
    "TaskCreated":    [{ "hooks": [{ "type": "http", "url": "http://127.0.0.1:4300/hooks/TaskCreated" }] }],
    "TaskCompleted":  [{ "hooks": [{ "type": "http", "url": "http://127.0.0.1:4300/hooks/TaskCompleted" }] }],
    "PermissionRequest": [{ "hooks": [{ "type": "http", "url": "http://127.0.0.1:4300/hooks/PermissionRequest" }] }],
    "PermissionDenied":  [{ "hooks": [{ "type": "http", "url": "http://127.0.0.1:4300/hooks/PermissionDenied" }] }],
    "Notification":   [{ "hooks": [{ "type": "http", "url": "http://127.0.0.1:4300/hooks/Notification" }] }],
    "Stop":           [{ "hooks": [{ "type": "http", "url": "http://127.0.0.1:4300/hooks/Stop" }] }],
    "StopFailure":    [{ "hooks": [{ "type": "http", "url": "http://127.0.0.1:4300/hooks/StopFailure" }] }],
    "SessionEnd":     [{ "hooks": [{ "type": "http", "url": "http://127.0.0.1:4300/hooks/SessionEnd" }] }]
  }
}
```

**`SessionStart` is a command hook, and that is not a style choice.** Measured on
Claude Code 2.1.233: an HTTP hook registered for `SessionStart` never fires,
while a command hook in the same settings file does (doc 14, confirmed again in
doc 15). Session binding and compaction repair both depend on that event, so
`init` writes a small bridge script that forwards the payload to the same
endpoint with `curl` and relays the board's JSON reply on stdout - which is
where Claude Code reads a command hook's decision, so context injection still
works.

The bridge exits 0 unconditionally. A board that is down or slow must never be
the reason a session fails to start.

Every other event was checked across both transports and arrives over HTTP,
including `SubagentStart` - an earlier guess that it needed the same treatment
was tested and disproved (doc 15).

Notes on specific choices:

- `PermissionRequest` and `PermissionDenied` are registered, but they do not
  fire in every permission mode: under `dontAsk` a refused call emits neither,
  and shows up only as a `PreToolUse` with no outcome. The board therefore
  detects unresolved tool intents directly rather than relying on these events
  (doc 15).
- `PreToolUse` and `PostToolUse` are matched to mutating tools plus `Bash`. Matching
  everything would multiply event volume by an order of magnitude for Read and Grep
  calls that tell the operator nothing. Read-tool events can be enabled per board for
  research-heavy cards, where knowing what the agent looked at is genuinely useful.
- `PreCompact` gets an extended timeout because the board performs a synthesis sweep
  before allowing compaction (section 4).
- Bind to `127.0.0.1`, never `0.0.0.0`. Transcript content includes source code.

`npx gorilla doctor` verifies the installation by checking settings validity, port
availability, and whether events have been received recently, and reports precisely
which hooks are silent.

## 2. Planning: how cards are created

`gorilla init` installs a project slash command, `/gorilla:plan`. The operator runs an
ordinary planning conversation with Claude - decomposing a feature, triaging a backlog,
breaking down a migration - and then invokes the command. Its instructions direct Claude
to POST the agreed decomposition to the board:

```
POST /api/boards/:board/plans
{
  "sourceSessionId": "...",
  "cards": [
    {
      "title": "...",
      "body": "...",
      "goalCondition": "...",
      "guardrails": { "scope": ["src/ingest/"], "prohibit": ["schema changes"], "verify": "npm test" },
      "agentModel": "sonnet",
      "dependsOn": ["<title of another card in this batch>"]
    }
  ]
}
```

The command's instructions carry the goal-authoring rules from section 4 and the
guardrail taxonomy from doc 05, so the planning agent produces conditions the evaluator
can actually assess rather than aspirations. The board validates each card on receipt
and returns per-card warnings, which Claude reports back in the planning conversation
where they can be fixed immediately.

Everything a plan creates lands unstarted. Promotion to Ready and dispatch are operator
actions (doc 05).

Cards can also be created by hand in the interface. The planning path exists because
that is the working habit; it is not the only way in.

## 3. Binding a session to a card

### Launched mode (primary path)

The board spawns the session itself when a card is dispatched:

```
claude -p "/goal <composed condition>"
  --output-format stream-json --verbose
  --model <card.agentModel>
  --permission-mode <card.permissionMode>
  --allowedTools <derived from guardrails>
  --append-system-prompt-file <card-context.md>
  --settings <gate-and-guardrail overlay>
```

with `GORILLA_CARD_ID` in the environment. The `session_id` arrives in the first
`system/init` event and the binding is recorded immediately, so no inference is needed
and no claim step is required of the operator.

`card-context.md` is generated per run and contains the card body, the guardrails, any
ledger entries the operator has accepted or promoted, and a short statement of what
previous runs on this card already established. This is the outbound half of the context
loop: the card is not a label on the work, it is an input to it.

The `--settings` overlay adds the `PreToolUse` deny rules derived from expressible
guardrails (doc 05). Rules are passed at launch rather than written into the project's
settings file, so a card's restrictions apply to that card's session and nothing else.

Cancellation is SIGTERM, which aborts the turn, runs `SessionEnd` hooks, and exits 143.
The stream-json output is consumed in parallel with the hook stream; it supplies
`system/init` metadata, `system/api_retry` events, and subagent messages correlated by
`parent_tool_use_id`.

### Attached mode (secondary, always on)

The operator works in their terminal as normal. On `SessionStart`, the board responds
with `additionalContext` naming the board and any card already claimed for that `cwd`,
plus instruction on how to claim one:

```json
{
  "hookSpecificOutput": {
    "hookEventName": "SessionStart",
    "additionalContext": "Gorilla board 'kanban' is observing this directory. No card is claimed for this session. To bind, run /gorilla:claim <card-id>. Open cards: 12 (Ledger synthesis pipeline), 15 (Gate policy UI)."
  }
}
```

The `/gorilla:claim` slash command is a small project command installed by
`gorilla init` that POSTs to the board. Until a card is claimed, events are held
against a provisional inferred card (doc 05).

## 4. Goal authoring

The board composes the `/goal` condition from card fields rather than free text,
because the evaluator's limitations (doc 02, surface D) are specific and
counter-intuitive. The composed condition follows a fixed structure:

```
<measurable end state>, verified by <stated check whose output appears in the
conversation>, without modifying <constraints>. Report progress each turn and stop
after <N> turns if not met.
```

The editor warns when:

- The condition contains no verifiable check, because the evaluator cannot run commands
  and will be judging vibes.
- The condition exceeds 4,000 characters.
- No turn or time bound is present, since goals without one can run indefinitely.

This is a small feature with disproportionate value. Most `/goal` disappointments trace
to conditions the evaluator structurally cannot assess.

## 5. Compaction capture and repair

This is the highest-value path in the system (P4) and warrants its own sequence. Capture
is specified here; the repair half is specified in doc 12.

1. `PreCompact` fires with `trigger_reason`.
2. The board reads the tail of the transcript at `transcript_path` - the content about
   to be discarded.
3. It runs an extraction pass over that window, producing LedgerEntries: decisions
   made, assumptions adopted, constraints stated, open questions.
4. It writes a `compaction` marker to the card timeline recording the pre-compaction
   token count, the number of entries extracted, and the trigger reason.
5. It responds allowing compaction to proceed.

If step 3 exceeds the budget, the board persists the raw window to disk under the card
and extracts asynchronously. It never blocks compaction on its own latency (P7, fail
open).

`PostCompact` closes the marker. The card timeline renders the compaction as a visible
discontinuity - a horizontal rule with "context compacted here; N entries preserved" -
because the operator needs to know that the agent's memory of everything above that
line is now a summary.

**`PostCompact` cannot inject context.** Verified against the hooks reference: it is
non-blocking and its output is shown to the user, not to the model. It is telemetry
only. The events whose stdout Claude Code adds as context the model can see are
`UserPromptSubmit`, `UserPromptExpansion`, and `SessionStart` - and `SessionStart`
accepts a `compact` matcher. Handing the agent back what compaction discarded therefore
runs through `SessionStart:compact`, which is where doc 12 picks the sequence up.

## 6. Review gates

When a board has gates enabled and a card is in a gated column, `Stop` and
`TaskCompleted` events are evaluated by the `gate` module.

For an HTTP hook, blocking is expressed via the JSON decision in the response body
rather than exit code 2. On block, the response supplies a reason that becomes
feedback to the agent:

```json
{
  "continue": false,
  "stopReason": "Gorilla gate: card 12 requires operator acknowledgement. The brief has been generated and the operator has been notified. Do not mark this task complete; summarise your remaining uncertainties instead."
}
```

Gate policy is per board and per column, with three settings:

- **Off** - purely observational. The default for the first run, so the operator can
  build trust before granting the tool the ability to hold work.
- **Acknowledge** - the card cannot enter the terminal column until the operator has
  opened the brief and confirmed. The agent is told to stop and wait.
- **Verify** - as above, plus a deterministic check the board runs itself (build, test
  command, or a git-clean assertion) whose result is attached to the brief. This
  compensates for the `/goal` evaluator's inability to run commands.

## 7. Board-to-agent messaging

When the operator rejects a ledger assumption or leaves a comment on a running card,
that correction must reach the agent.

**v1 mechanism.** For launched sessions, the board queues the correction and delivers
it via `claude -p --resume <session-id>` once the current run ends. For attached
sessions, the board surfaces the correction in the interface as copyable text and
raises a desktop notification. This is honest about the constraint: a local process
cannot inject into an interactive terminal session.

**Phase 4 mechanism.** Channels (doc 02, surface F) are designed for exactly this -
pushing an event into an already-running session. Gorilla would ship a channel plugin.
This is deferred because channels are a research preview with a protocol contract that
may change and an allowlist requirement.

## 8. What the board deliberately does not do

- It does not use `PreToolUse` blocking to police the agent's behaviour in general. The
  only denials it issues are the ones derived from guardrails the operator wrote before
  dispatch (doc 05). Ad-hoc supervision during a run is reintroducing the interrupt (P2),
  and permission rules already exist for the rest.
- It does not write to `~/.claude/tasks/`. Those files are experimental, lock-protected,
  and owned by Claude Code.
- It does not modify CLAUDE.md or auto memory. Those shape future agent context; the
  ledger is for the operator. Conflating them would corrupt both.
