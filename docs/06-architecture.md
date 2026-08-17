# 06 - Architecture

## Shape

A single local Node process, started with `npx gorilla`, serving both an HTTP API and
a static single-page application on `http://localhost:4300`. No external services, no
database server, no container.

```
                         Claude Code session(s)
                                  |
              HTTP hooks          |          transcript file
       POST /hooks/:event         |          ~/.claude/projects/.../*.jsonl
                                  |
                    ┌─────────────▼──────────────┐
                    │      Gorilla process       │
                    │                            │
                    │  ingest ──► normalise ──►  │
                    │      store (SQLite)        │
                    │            │               │
                    │      synthesise ◄── LLM    │
                    │            │               │
                    │      gate decision ────────┼──► hook response (allow / block)
                    │            │               │
                    │      SSE broadcast         │
                    │            │               │
                    │      launcher ─────────────┼──► claude -p (child process)
                    └────────────┼───────────────┘
                                 │
                            Browser SPA
```

## Modules

**`ingest`** - Fastify route group handling `POST /hooks/:event`. Must be fast: hooks
are synchronous by default and a slow response stalls the agent. The handler writes the
raw event, resolves the binding, decides whether the event is gated, and returns. Any
work that is not required for the response - synthesis, git inspection, diff parsing -
is queued and performed after the response is sent.

Target: p99 under 25 ms for non-gated events. Gated events (`Stop`, `TaskCompleted`)
may take longer because a decision is genuinely required, but must be bounded well
under the hook timeout.

**`binding`** - Resolves `(session_id, cwd)` to a Run, applying the three mechanisms in
doc 05. Holds a hot in-memory map; SQLite is the fallback and the durable record.

**`transcript`** - A `chokidar` watcher over the `transcript_path` values seen in hook
payloads, tailing each file for appended lines. Supplies token usage, assistant text
and thinking blocks, and the pre-compaction window content. Fully isolated: it exports
a narrow typed interface, validates every record against a permissive schema, and
reports unknown record types as a `schema-drift` diagnostic rather than throwing. If
this module dies, the process continues and the interface shows a degraded badge.

**`synthesise`** - The summarisation pipeline that turns events into LedgerEntries and
briefs. Runs out of band, triggered by turn boundaries, compaction, and card open. See
doc 08 for policy, cost control, and prompting.

**`gate`** - Evaluates whether an incoming blockable event should be allowed. Pure
function of card state and board policy, so it is trivially testable.

**`launcher`** - Spawns and supervises `claude -p` child processes, parses their
`stream-json` output, and handles cancellation via SIGTERM. Also handles resume.

**`git`** - Reads branch, HEAD, and diffs via `simple-git`. Provides the authoritative
change set for a run so agent claims can be checked against reality.

**`api`** - REST for card and board mutations; SSE at `GET /stream` for live updates.
SSE rather than WebSocket because the traffic is overwhelmingly server-to-client,
reconnection semantics are built in, and it survives proxies without configuration.

## Technology selection

| Concern | Choice | Rationale |
| --- | --- | --- |
| Runtime | Node 22 LTS, TypeScript | Claude Code users have it; broadest ecosystem |
| Server | Fastify | Fast JSON handling, first-class schema validation, low overhead on the hook path |
| Storage | SQLite via `better-sqlite3`, Drizzle ORM | Synchronous single-writer local access, transactional, FTS5 for ledger search, one file to back up |
| Frontend | React 19 + Vite | Fast iteration; no server-rendering requirement for a localhost tool |
| Drag and drop | `@dnd-kit` | Community standard, ~6 KB core, strong keyboard accessibility. Boards here are tens of cards, so Pragmatic DnD's large-list performance advantage is irrelevant |
| Styling | Tailwind CSS | Dense information layouts benefit from utility composition |
| Realtime | Server-Sent Events | Unidirectional, auto-reconnecting, simple |
| Markdown | `react-markdown` with `rehype-highlight` | Briefs and ledger detail are markdown |
| File watching | `chokidar` | Reliable cross-platform tailing |
| Git | `simple-git` | Thin wrapper, no native build |
| Process supervision | `execa` | Ergonomic child process handling with clean signal semantics |
| Summarisation | `claude -p` via the Claude Code CLI, Haiku 4.5 default with escalation | Runs on the quota the operator already has; a separate API key is a second bill for one piece of work. See doc 08 |
| Testing | Vitest, plus a recorded-fixture hook replay harness | The hook stream is the system's real input and must be testable offline |

Deliberately excluded: Next.js (no SSR requirement, and the API surface is small
enough that a framework adds more than it removes), Postgres and Docker (violates P9),
Redis (a single process needs no external queue), and any authentication layer
(non-goal).

## Concurrency and ordering

Hook deliveries for one session are effectively serialised by the agent's own
execution, but subagents and async hooks break that assumption. Events therefore carry
a per-run monotonic `seq` assigned on receipt, and the timeline is rendered by
`receivedAt` with subagent events nested under their parent by `agent_id`. Out-of-order
delivery is expected and must not corrupt the ledger; synthesis reads a stable snapshot
rather than streaming state.

## Failure posture

| Failure | Behaviour |
| --- | --- |
| Board process is down when a hook fires | Claude Code treats a failed HTTP hook as a non-blocking error and continues. Work proceeds; those events are lost from the live stream but recoverable from the transcript on next start via a backfill pass |
| Transcript format changes | `schema-drift` diagnostic surfaced in the interface; usage gauge and text enrichment degrade; hook-derived features unaffected |
| Summarisation API unavailable or budget exhausted | Ledger falls back to deterministic, non-LLM entries (file changes, tool failures, goal verdicts). The brief shows a mechanical summary with an explicit banner |
| Gate cannot reach a decision in time | Fail open. Blocking the agent on a board bug is worse than a missed gate; the card is flagged `gate-failed` and the operator is told |
| SQLite lock contention | Single writer by construction; WAL mode enabled |

The fail-open choice on gates deserves emphasis: this tool must never be the reason an
autonomous run stalls at 3 a.m.

## Backfill

On start, and on demand, the board can reconstruct runs from transcript files alone -
scanning `~/.claude/projects/<slug>/` for sessions in a board's `cwd` that have no
corresponding Run. This covers sessions run while the board was closed and makes
adoption non-destructive: installing Gorilla on an existing project yields immediate
history rather than an empty board.
