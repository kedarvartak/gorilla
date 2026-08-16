# 14 - Compaction Probe Findings

Produced by T9 (doc 13). Measured against Claude Code **2.1.233** on Linux,
2026-08-16, with `gorilla probe`.

This document reports. It does not redesign doc 12; the implications are stated
and left as decisions.

## Why this was run

Doc 12's compaction repair - handing the agent back the guardrails and decisions
that compaction discarded - is the highest-leverage feature in the product, and
Phase 2 and 3 are planned on top of it. It rests on three claims about Claude
Code's behaviour that the documentation supports but that had not been observed:

- **Q1.** `PreCompact` fires, and the transcript tail is readable at that moment.
- **Q2.** `SessionStart` fires with matcher `compact` after a compaction.
- **Q3.** Text returned from that `SessionStart` hook reaches the model.

## Method

A local server receives hook events. A scratch project registers, in one
settings file and for the same five events, **both** a command hook and an HTTP
hook. Registering both is what makes a difference between them attributable to
Claude Code rather than to how the probe was configured.

Compaction is triggered with `/compact` on a resumed session rather than by
filling the context window. Both paths reach the same compaction code, and
forcing a genuine auto-compaction costs hours and a very large number of tokens
for the same answers.

For Q3 the failure mode is a false positive: a model asked whether it received a
code will often produce something plausible. So the probe injects a 128-bit
nonce (`GORILLA-<32 hex chars>`) and then asks for it in a form that a model
which never saw it cannot satisfy - it must reproduce the exact string, and the
documented answer when absent is the literal token `NO-CODE-RECEIVED`. Anything
that is neither is graded `inconclusive` rather than counted as a clean
negative.

## Results

```
Q1 PreCompact fired:                 YES
   transcript readable at that time: YES (80 chars)
Q2 SessionStart:compact fired:       NO
Q3 injected text reached the model:  RECEIVED
   nonce:  GORILLA-7CEF981CB1DA5D8F1D657C71DADC707C
   answer: GORILLA-7CEF981CB1DA5D8F1D657C71DADC707C

SessionStart over command hook:      YES
SessionStart over http hook:         NO
```

Full event trace across the three invocations:

```
command:SessionStart (startup)
http:Stop
command:Stop
http:SessionEnd
command:SessionEnd
command:SessionStart (resume)
http:PreCompact
command:PreCompact
http:SessionEnd
command:SessionEnd
command:SessionStart (resume)
http:Stop
command:Stop
http:SessionEnd
command:SessionEnd
```

### Q1: confirmed

`PreCompact` fires and the transcript is readable at that moment, over both
transports. Doc 07 section 5's capture sequence works as specified. This is the
part of doc 12 that was most important to confirm, because the pre-compaction
window is the one thing that cannot be recovered later.

### Q3: confirmed

The model reproduced the exact nonce. `additionalContext` returned from a
`SessionStart` hook reaches the model and it acts on it. The injection channel
doc 12 depends on exists and works.

This was verified twice, independently: once through the probe's command bridge,
and once with a standalone command hook emitting the JSON directly.

### Q2: not decidable in non-interactive mode

`SessionStart` fired with source `startup` and `resume`, never `compact`. That
is not evidence that the `compact` source does not exist. In `-p` mode the
process exits with the compaction, so there is no session left to restart and
nothing that a post-compaction `SessionStart` could attach to. The observed
sequence - `SessionStart (resume)`, `PreCompact`, `SessionEnd` - is consistent
with that reading.

`PostCompact` did not fire either, which supports the same explanation: the
invocation ended at the compaction.

**This question moves to T10**, where an interactive session runs long enough to
auto-compact and stay alive. It is the one Phase 0 exit criterion this probe
cannot close.

> **Answered by T10 (doc 15).** `SessionStart` does fire with source `compact`,
> between `PreCompact` and `PostCompact`. This probe could not see it because it
> registered `SessionStart` as an HTTP hook, which never receives that event, so
> the result below is a second confirmation of the transport finding rather than
> a contradiction of it. Doc 12's repair loop is viable as specified.

### Unplanned finding: HTTP hooks do not receive SessionStart

The most consequential result, and it was not one of the three questions.

With a command hook and an HTTP hook registered for the same events in the same
settings file, `Stop`, `SessionEnd` and `PreCompact` arrived over both. `SessionStart`
arrived **only** over the command hook, on all three invocations. `http:SessionStart`
appears zero times in the trace above.

This was confirmed three separate ways:

1. The probe's side-by-side comparison, above.
2. An HTTP-only settings file: `Stop` and `SessionEnd` arrived, `SessionStart` did not.
3. A command-only settings file: `SessionStart startup` arrived.

Whether this is intended or a defect in 2.1.233 is not something the probe can
determine. What matters here is that it is reproducible.

## Implications

Stated, not acted on. Doc 12 and doc 07 are unchanged by this document.

**Doc 07 section 1 registers `SessionStart` as an HTTP hook.** As measured, that
entry will never fire. Two features depend on it:

- Session binding and the claim prompt (doc 07 section 3).
- Compaction repair and session priming (doc 12).

**A bridge works.** The probe's command hook forwards the payload to the board
with `curl` and relays the board's JSON reply on stdout, and injection succeeded
through it. So the capability is reachable; it costs one small script on disk
for the events HTTP does not serve, which weakens but does not break P9's
zero-ceremony installation - `gorilla init` can write it.

**The dependency grade in doc 02 needs revisiting.** Hooks are graded "stable,
documented, core features may depend on it". That grade holds for the mechanism
but not uniformly across events and transports, and the difference is not
documented.

**Doc 12's fallback is still available.** `UserPromptSubmit` also accepts stdout
as context, so even if a post-compaction `SessionStart` never fires, repair can
be delivered on the next prompt. That is later than ideal - the agent takes one
turn on a compacted context before being repaired - but it is not a dead end.

## Suggested follow-ups

1. **T10 must answer Q2** in an interactive session that auto-compacts. Until
   then, treat post-compaction `SessionStart` as unproven rather than working.
2. **Change the `SessionStart` registration to a bridged command hook** in doc 07
   section 1, or verify against a newer Claude Code before assuming the HTTP
   behaviour persists.
3. **Re-run this probe after any Claude Code upgrade.** It is cheap - three short
   prompts - and it guards the assumption the most valuable feature rests on.
4. **Extend the probe to every event Gorilla registers**, not just the five here.
   If `SessionStart` differs by transport, others may too, and doc 07 registers
   fifteen.

## Reproducing

```
npm run build && node dist/cli/index.js probe --port 4496
```

Runs three short `claude -p` invocations in a temporary directory. It does not
touch the current project's settings, and costs a few thousand tokens.
