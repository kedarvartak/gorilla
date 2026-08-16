# 13 - Phase 0 Task Plan

Ten tasks covering Phase 0 in full (doc 10). Scoped to Phase 0 deliberately: Phase 1's
shape depends on what the verification run in T10 reveals, so planning it now would be
planning against assumptions the last task exists to test.

Each task is written in the card shape from doc 05 - goal condition, guardrails, model,
dependencies - so this plan can seed the board once the board exists. Goal conditions
follow the doc 07 §4 structure, because the `/goal` evaluator cannot run commands and can
only judge what the agent surfaced in the conversation.

## Dependency graph

```
T1 scaffold
 ├─► T2 schema ──┐
 └─► T4 init CLI │
                 ├─► T3 ingest ──┬─► T5 fixtures ──┐
                 │               ├─► T6 stream     ├─► T9 compaction probe ──► T10 verify
                 │               └─► T8 doctor     │
                 └─► T7 transcript reader ─────────┘
```

T1 through T4 are sequential-ish foundation. T5, T6, T7, T8 are independent of each
other and could run in any order. T9 and T10 are the exit gate.

---

## T1. Repository scaffold

**Body.** TypeScript monorepo-lite layout: `src/server`, `src/cli`, `src/web`, `test`.
Node 22, ESM, strict TypeScript. Vitest configured with a passing smoke test. ESLint and
Prettier. `package.json` scripts for `dev`, `build`, `test`, `lint`. A `bin` entry for
`gorilla`. No application logic.

**Goal condition.** `npm run build`, `npm test`, and `npm run lint` each exit 0 with
their output shown, and `npx gorilla --help` prints usage, without adding any dependency
outside the list in doc 06.

**Guardrails.** Scope: repository root and `src/`, `test/`. Prohibit: adding dependencies
not named in doc 06's technology table; committing anything.

**Model.** Haiku. Mechanical setup with a clear specification.

**Depends on.** Nothing.

---

## T2. Storage schema and migrations

**Body.** Drizzle schema and migrations for the doc 05 entities needed in Phase 0:
`boards`, `runs`, `events`. Cards, ledger entries, and briefs are Phase 1 and 2 - define
them only where a foreign key demands it. Events table carries `runId`, `sessionId`,
`seq`, `eventName`, `receivedAt`, `payload` as JSON text, with generated columns and
indexes for `toolName`, `toolUseId`, `promptId`, `agentId`. WAL mode enabled. Database at
`~/.gorilla/gorilla.db`, path overridable by env for tests.

**Goal condition.** A migration run against a temporary file creates every table, and a
test that inserts 10,000 events and queries them by session and by event name passes with
its output shown. Write throughput is reported in the transcript.

**Guardrails.** Scope: `src/server/db/`. Prohibit: any schema for ledger entries or
briefs beyond a placeholder; ORM features requiring a build step at runtime.

**Model.** Sonnet. Schema shape has downstream consequences and deserves real judgement.

**Depends on.** T1.

---

## T3. Hook ingest endpoint

**Body.** Fastify server exposing `POST /hooks/:event`. Permissive validation - unknown
fields ignored, missing optionals tolerated (R7). Assigns `seq`, resolves or creates a
provisional run from `session_id` and `cwd`, writes the event, returns immediately.
Anything not needed for the response is deferred. Returns an empty allow response for
every event in Phase 0; no gating logic yet. Structured logging of receipt latency.

**Goal condition.** A test posting each of the fifteen event types from doc 07 persists
all fifteen correctly attributed to one run, and a benchmark over 1,000 sequential posts
reports p99 latency under 25 ms with the figure printed in the transcript. No test
depends on a live Claude Code session.

**Guardrails.** Scope: `src/server/`. Prohibit: any synthesis, any model call, any git
operation on the request path; binding to any interface other than 127.0.0.1.

**Model.** Sonnet.

**Depends on.** T1, T2.

---

## T4. `gorilla init` CLI

**Body.** Writes HTTP hook configuration into the project's `.claude/settings.local.json`
per doc 07 §1. Must merge, never replace: existing hooks for the same event are preserved
and the Gorilla entry appended. Idempotent - running twice produces the same file.
`--shared` targets `.claude/settings.json` instead. `--dry-run` prints the resulting file
without writing. Refuses to run outside a directory containing `.claude` or a git
repository, unless forced.

**Goal condition.** Tests covering four cases pass with output shown: empty project,
project with unrelated existing hooks, project with a previous Gorilla install
(idempotency), and `--dry-run` writing nothing. The generated JSON is valid against the
hook configuration shape in doc 07 §1, and no existing hook entry is lost in any case.

**Guardrails.** Scope: `src/cli/`. Prohibit: writing to `~/.claude/settings.json`, or to
any settings file outside the target project; modifying CLAUDE.md.

**Model.** Sonnet. Settings merging is the kind of subtle work where a plausible
implementation silently destroys a user's configuration.

**Depends on.** T1.

---

## T5. Fixture recorder and replay harness

**Body.** Recorder mode captures every received hook payload to a timestamped JSONL
fixture on disk, preserving arrival order and inter-event delays. Replay feeds a fixture
back into a running server, optionally at original pacing or as fast as possible. A CLI
surface for both. This is the tooling every later phase is tested against, so fixtures
must be redactable - a flag that strips file contents and command output from payloads
before they are written.

**Goal condition.** A fixture recorded from a real Claude Code session replays into a
clean database and produces an identical event set, verified by a comparison whose result
is printed. Redacted replay produces the same event count and ordering with content
fields emptied.

**Guardrails.** Scope: `src/server/fixtures/`, `src/cli/`. Prohibit: storing fixtures
inside the repository by default - they contain source code and shell output.

**Model.** Sonnet.

**Depends on.** T3.

---

## T6. Event stream and minimal page

**Body.** SSE endpoint at `GET /stream` broadcasting events as they are ingested, with
reconnection support via last-event-id. A single unstyled HTML page listing events live -
timestamp, session, event name, tool name. No React, no board, no card. This exists to
make the pipe visible during the verification run, and will be replaced in Phase 1.

**Goal condition.** With the server running, a replayed fixture appears in the page in
correct order in real time, and a client disconnected mid-replay and reconnected receives
the events it missed. Both confirmed with output shown.

**Guardrails.** Scope: `src/server/stream/`, `src/web/`. Prohibit: introducing the
frontend build toolchain from doc 06 - this page is plain HTML and is deliberately
throwaway.

**Model.** Haiku.

**Depends on.** T3.

---

## T7. Transcript locator and tail reader

**Body.** The isolated, defensive module described in doc 06. Takes a `transcript_path`
from a hook payload, tails the file for appended records, and exposes a narrow typed
interface: token usage from `message.usage`, assistant text and thinking blocks, and the
ability to read the last N tokens of the window on demand. Validates permissively;
unknown record types are counted and surfaced as a `schema-drift` diagnostic, never
thrown. Must not crash the process under any input, including truncated or partially
written lines.

**Goal condition.** Against at least three real transcript files from this machine, the
module extracts a context-utilization figure and reports it, handles a deliberately
corrupted file without throwing, and reports unknown record types rather than failing.
All three results are printed in the transcript.

**Guardrails.** Scope: `src/server/transcript/`. Prohibit: any other module importing
transcript types directly - the interface is the boundary (P7); depending on any field
not observed in doc 02's verified list without marking it optional.

**Model.** Opus. The format is undocumented and version-fragile; this is the module most
likely to be subtly wrong in ways tests written from the same misunderstanding will not
catch.

**Depends on.** T1, T2.

---

## T8. `gorilla doctor`

**Body.** Diagnostic command reporting: whether the settings file is present and valid,
whether the port is available or already serving Gorilla, which of the fifteen configured
hooks have delivered an event in the last 24 hours and which are silent, the
`schema-drift` state from T7, and the database location and size. Exit code non-zero when
anything is misconfigured, so it can gate the verification run.

**Goal condition.** Run against a correctly configured project it reports all hooks
healthy and exits 0; run against a project with `gorilla init` not applied it names the
missing configuration and exits non-zero. Both outputs shown.

**Guardrails.** Scope: `src/cli/`. Prohibit: modifying any configuration - this command
diagnoses only.

**Model.** Haiku.

**Depends on.** T3, T4.

---

## T9. Compaction probe

**Body.** The experiment that de-risks doc 12. A harness that runs a Claude Code session
long enough to trigger auto-compaction and records, definitively:

1. Does `PreCompact` fire, and is the transcript tail readable at that moment?
2. Does `SessionStart` fire with matcher `compact` afterwards?
3. Does text returned from that `SessionStart` hook reach the model?

Question 3 is answered by injecting a distinctive nonce token in the hook response and
then asking the agent to repeat it. The harness must distinguish "the agent saw the
nonce" from "the agent inferred something plausible", so the nonce must be
unguessable and the question must be asked in a way a model without it would fail.

Deliverable is a written findings document in `docs/`, not only working code.

**Goal condition.** A findings document exists answering all three questions with
evidence quoted from a real session, and states explicitly whether doc 12's compaction
repair is viable as specified or requires the `UserPromptSubmit` fallback.

**Guardrails.** Scope: `src/server/`, `test/`, `docs/`. Prohibit: changing doc 12's
design before the findings are written - the experiment reports, it does not redesign.

**Model.** Opus. Experiment design where the failure mode is a false positive.

**Depends on.** T3, T5, T7.

---

## T10. Phase 0 verification run

**Body.** The exit gate from doc 10. Run a genuine forty-minute `/goal` session in auto
mode on a real project with Gorilla observing, long enough to trigger compaction. Produce
a report covering: every event type received with counts, ordering correctness, ingest
latency distribution, whether the agent was measurably slowed, the three compaction
findings from T9 confirmed under real conditions rather than a harness, and any hook that
never fired.

The report must state plainly whether Phase 0 passed and what Phase 1 should change as a
result.

**Note.** This is a human-supervised task, not an autonomous one. An agent can build the
instrumentation and write the report, but the run itself needs a real session doing real
work, and the judgement about whether the agent felt slowed is the operator's.

**Goal condition.** A verification report exists in `docs/` covering all six items, based
on a real session of at least forty minutes that compacted at least once, and ending in
an explicit pass or fail against doc 10's Phase 0 gate.

**Guardrails.** Scope: `docs/`, `test/`. Prohibit: fabricating or extrapolating any
measurement - every figure must come from a recorded fixture or a database query, both
cited.

**Model.** Opus. The output is judgement, and the failure mode is a report that says
things went well.

**Depends on.** T5, T6, T8, T9.

---

## What is deliberately not here

- Cards, boards, drag and drop, the column model. Phase 1.
- Any ledger extraction or model call. Phase 2.
- Gates, planning intake, the dispatcher, launched mode. Phase 1 and 3.
- The React frontend. T6 is throwaway HTML on purpose.

## Sequencing note

T1 through T4 could be collapsed into fewer, larger tasks. They are kept separate because
Phase 0's real purpose is to test whether this decomposition-and-dispatch loop works at
all, and a plan of four large tasks would not exercise it. If the loop proves tedious at
this granularity, that is itself a Phase 0 finding worth recording in T10's report.
