# 11 - Risks, Dependencies, and Open Decisions

## Product risks

### R1. Synthesis is plausible but wrong

The central risk. A brief that reads well and is subtly inaccurate is worse than no
brief, because it produces confident wrong belief rather than acknowledged ignorance.
The operator would stop reading transcripts and start trusting a fabrication.

Mitigations: mandatory traceability, with unresolvable entries discarded in code rather
than displayed with a caveat; confidence shown per entry; the precision target in doc 08
set tighter than the recall target on the principle that noise is more damaging than
omission; the claim-versus-reality check against git, which is model-independent
ground truth; and the Phase 2 exit gate, which blocks the product if this is not met.

Residual risk after mitigation: moderate. This risk cannot be eliminated, only measured.

### R2. The tool becomes the thing being maintained

Personal tooling for a person who builds a great deal has a characteristic failure: the
instrument absorbs the attention meant for the work. Mitigations: the non-goals in doc 04
are unusually aggressive on purpose; Phase 0 is deliberately small; and the product is
used on its own construction from Phase 1, so maintenance burden is felt immediately
rather than discovered later.

### R3. Nobody reads the brief either

If the brief is not genuinely faster than the transcript, the operator will skip it
exactly as they skip the transcript, and the product will have relocated the problem.
This is why time-to-resync is the headline metric and why "since you last looked" is
specified to be answerable in one line when nothing changed. A brief that always demands
two minutes will be skipped when the operator has thirty seconds.

### R4. Gates are switched off

Enforced gates are the strongest feature and the most likely to be disabled in a moment
of impatience, after which the product becomes observational only. Mitigations: gates
default off so trust is built before authority is granted; the acknowledge gate is
cheap to satisfy; and gate policy is per column, so a fast lane for trivial cards is
available without disabling the mechanism globally.

### R5. Cost surprise

Continuous summarisation of a continuously running agent. If the first month's bill is
startling the tool will be uninstalled regardless of its value. Mitigations: mechanical
extraction covers the baseline with zero model calls; small fast model by default;
hard per-card and per-day budgets that degrade rather than overspend; and spend shown
in the header, always.

## Dependency risks

### R6. Transcript format drift

The docs state plainly that the JSONL format is internal and changes between versions.
This is a certainty, not a risk. It is handled by architecture rather than hope: the
parser is one isolated module, every core feature works without it, and drift surfaces
as a visible diagnostic rather than a crash. Impact when it happens: the utilization
ring and pre-compaction extraction degrade. The latter is painful, since compaction
capture is the highest-value path, so the parser is the first thing to check after any
Claude Code upgrade.

### R7. Hook payload changes

Lower risk than R6, since hooks are a documented, versioned public interface with a
stable common payload. Handled by validating permissively - unknown fields ignored,
missing optional fields tolerated - and by the fixture replay harness, which will show a
diff in behaviour when a payload shape changes.

### R8. Feature surface shifts underneath

Agent teams are experimental, channels are a research preview, and `/goal` is recent.
Any could change. Handled by the dependency grading in doc 02: nothing graded
experimental supports a core feature, and channels are explicitly a Phase 4 enhancement
with a working v1 fallback.

### R9. Hook latency stalls the agent

Synchronous hooks sit in the agent's critical path. A slow board response slows every
tool call. Handled by the p99 budget in doc 06, by doing no synthesis on the response
path, and by fail-open behaviour on the gate. This is measured in Phase 0's exit gate,
not assumed.

## Security considerations

Transcripts contain source code, environment details, and whatever appeared in shell
output, which routinely includes secrets. Consequences for the design:

- Bind to `127.0.0.1` only. Never `0.0.0.0`, never a LAN-reachable port.
- The SQLite file inherits user-only permissions and lives under `~/.gorilla/`.
- Content sent to the summarisation API is the operator's own transcript content going
  to the same provider already processing it, which is a defensible default, but it must
  be stated in the interface and a fully-local extraction mode should remain possible.
- No telemetry of any kind.
- Markdown export must be explicit per card, never automatic into a repository that may
  be pushed publicly.

## New risks introduced by the launched-first model

### R10. Guardrails believed to be enforced but which are not

The operator writes "do not change the schema" and reasonably assumes it is a rule. Most
guardrails are instructional text in a system prompt, which a model may violate. If the
interface presents all guardrails identically, the operator will trust soft ones as hard
and dispatch work unattended on that belief.

Mitigation: the enforcement taxonomy in doc 05 is surfaced in the interface, per
guardrail, at the moment it is written. The board states plainly which rules it can
enforce and which it can only request, and records every denial and every apparent
violation as a ledger risk entry.

Residual risk: moderate, and inherent. It is reduced by honesty, not eliminated.

### R11. Autonomous dispatch amplifies a bad plan

Six cards queued from one planning conversation share that conversation's mistakes. Serial
dispatch running unattended can execute all six before anyone notices the first was
misconceived, and later cards may build on the earlier ones' errors.

Mitigation: the dispatcher halts on failure, gate, or question rather than working
through the queue (doc 05); plans land unstarted and require explicit promotion to Ready;
card dependencies express the ordering that makes a halt meaningful. Manual dispatch is
the default until the operator has calibrated their own planning.

## Resolved decisions

**D1. Launched-first.** Cards are planned up front with Claude, land on the board, and
are dispatched by the board with per-card guardrails. Attached mode remains permanently
supported and ships in the same phase, because an unobserved terminal session is the
blind spot the product exists to remove. Recorded as decision 9 below.

**D2. Gates in Phase 3, off by default.** Observational until the ledger has earned the
authority to hold work. Recorded as decision 10.

**D3. Model is per card.** Both the agent model and the synthesis model are card-level
settings with board defaults, chosen at planning time when the operator's judgement about
a task's difficulty is sharpest. Recorded as decision 11.

**D4. Name is Gorilla**, after the selective-attention experiment the problem statement
is drawn from.

## Open questions

Not blocking Phase 0, but worth deciding before the phase in which they bind:

- **Concurrency default.** Serial is specified, on P1 grounds. Whether a two-card default
  is better in practice is an empirical question that Phase 1 use will answer.
- **Where guardrails live.** Card-level and board-level are specified. Whether a project
  should also express them in a committed file, so they survive the board, is unresolved
  and interacts with P8.
- **Local extraction mode.** Whether to support a fully-local model for synthesis, for
  work whose transcripts should not leave the machine at all.

## Decision log

Decisions already taken, recorded so they are not silently revisited.

| # | Decision | Rationale |
| --- | --- | --- |
| 1 | Claude Code only, no multi-agent abstraction | The strongest features depend on Claude Code-specific mechanisms; genericising costs exactly those (doc 04) |
| 2 | HTTP hooks rather than shell command hooks | No scripts on disk, no `jq` dependency, installation is one settings file (doc 07) |
| 3 | SQLite rather than a server database | Single local writer, transactional, FTS5 included, one file to back up (doc 06) |
| 4 | SSE rather than WebSocket | Traffic is server-to-client; reconnection is built in (doc 06) |
| 5 | Transcript parsing is enrichment only | The format is documented as internal and version-fragile (doc 02) |
| 6 | Fail open on gate errors | The tool must never be the reason an unattended run stalls (doc 06) |
| 7 | `@dnd-kit` over Pragmatic drag-and-drop | Boards are tens of cards, so the large-list advantage is irrelevant; keyboard accessibility is not (doc 06) |
| 8 | The card, not the event, is the unit of presentation | Event viewers already exist and do not solve comprehension (doc 03) |
| 9 | Launched-first: plan with Claude, dispatch from the board | Authoritative binding, guardrails enforceable at launch, and it matches the intended working loop (doc 00) |
| 10 | Gates ship in Phase 3, off by default | The authority to hold work is granted to a tool that has proved its briefs are worth stopping for (R4) |
| 11 | Agent model and synthesis model are per-card | Task difficulty varies more than any single default can serve, and planning time is when the operator knows which is which (doc 05) |
| 12 | Serial dispatch by default | Two concurrent agents double what must be resynchronised, which is the cost the product exists to reduce (P1) |
| 13 | Compaction repair runs through `SessionStart:compact`, not `PostCompact` | `PostCompact` is non-blocking and display-only; its output never reaches the model (doc 12) |
| 14 | Only operator-accepted entries and explicit guardrails are eligible for injection | Re-injecting a mis-extracted constraint is worse than injecting nothing, because the agent acts on it (doc 12) |
| 15 | The project model never writes to CLAUDE.md | CLAUDE.md is instruction; the project model is description. Conflating them corrupts both (doc 07 §8) |
