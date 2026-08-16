import { randomBytes } from 'node:crypto';

/**
 * The compaction probe (T9).
 *
 * Doc 12's compaction repair - handing the agent back the guardrails and
 * decisions that compaction discarded - is the highest-leverage feature in the
 * product, and it rests on three claims about Claude Code's behaviour:
 *
 *   Q1. `PreCompact` fires, and the transcript tail is readable at that moment.
 *   Q2. `SessionStart` fires with matcher `compact` after a compaction.
 *   Q3. Text returned from that `SessionStart` hook reaches the model.
 *
 * The documentation supports all three. This probe checks them against a real
 * session, because building Phase 2 and 3 on a documented behaviour that turns
 * out not to hold is the expensive failure.
 *
 * The design problem is Q3, where the failure mode is a false positive: a model
 * asked "did you receive a verification code?" will often produce something
 * plausible. So the probe injects an unguessable nonce and asks a question that
 * a model which never saw it cannot answer correctly - it must reproduce the
 * exact string, and the expected answer when absent is a specific token.
 */

export interface ProbeNonce {
  readonly value: string;
  /** The context injected into the session. */
  readonly injection: string;
  /** The question asked afterwards. */
  readonly question: string;
}

/**
 * 128 bits of hex. Long enough that reproducing it by chance or by inference is
 * not a plausible explanation for a positive result.
 */
export function createNonce(
  random: () => string = () => randomBytes(16).toString('hex'),
): ProbeNonce {
  const value = `GORILLA-${random().toUpperCase()}`;

  return {
    value,
    injection:
      `Gorilla compaction probe. The verification code for this session is ${value}. ` +
      `If you are later asked for the Gorilla verification code, reply with exactly that code and nothing else.`,
    question:
      'What is the Gorilla verification code for this session? ' +
      'Reply with the code alone. If you have not been given one, reply with exactly NO-CODE-RECEIVED.',
  };
}

export type Verdict = 'received' | 'absent' | 'inconclusive';

/**
 * Grades an answer.
 *
 * `absent` requires the model to say so explicitly. Anything else that is not
 * the exact nonce is `inconclusive` rather than `absent`, because a model that
 * rambles has not demonstrated either outcome, and quietly counting that as a
 * clean negative would be as misleading as a false positive.
 */
export function gradeAnswer(answer: string, nonce: ProbeNonce): Verdict {
  const normalised = answer.trim().toUpperCase();

  if (normalised.includes(nonce.value)) return 'received';
  if (normalised.includes('NO-CODE-RECEIVED')) return 'absent';
  return 'inconclusive';
}

export interface HookObservation {
  readonly event: string;
  readonly matcher: string | null;
  readonly at: number;
}

export interface ProbeFindings {
  /** Q1 */
  readonly preCompactFired: boolean;
  readonly transcriptReadableAtPreCompact: boolean;
  readonly transcriptTailChars: number;
  /** Q2 */
  readonly sessionStartCompactFired: boolean;
  /** Q3 */
  readonly injectionVerdict: Verdict;
  readonly nonce: string;
  readonly answer: string;
  readonly observations: readonly HookObservation[];
}

export type Viability = 'viable' | 'unproven' | 'blocked';

/**
 * Compaction repair needs two things: a channel that reaches the model, and an
 * event that fires after a compaction to use it.
 *
 * The channel is settled by Q3. Whether `SessionStart` fires with source
 * `compact` cannot be settled by a non-interactive probe, because the process
 * exits with the compaction and there is no session left to restart - so a
 * negative Q2 here is `unproven`, not `blocked`. Only a failed Q3 blocks.
 */
export function viability(findings: ProbeFindings): Viability {
  if (findings.injectionVerdict !== 'received') return 'blocked';
  return findings.sessionStartCompactFired ? 'viable' : 'unproven';
}

const VIABILITY_MESSAGE: Record<Viability, string> = {
  viable: 'Doc 12 compaction repair is viable as specified.',
  unproven:
    'The injection channel works. Whether SessionStart fires with source=compact after an ' +
    'auto-compaction is not decidable in non-interactive mode and is deferred to T10.',
  blocked: 'The injection channel did not reach the model. Doc 12 needs its fallback path.',
};

export function summarise(findings: ProbeFindings): string {
  const mark = (value: boolean): string => (value ? 'YES' : 'NO');
  const sawSessionStartOverHttp = findings.observations.some((o) =>
    o.event.startsWith('http:SessionStart'),
  );
  const sawSessionStartOverCommand = findings.observations.some((o) =>
    o.event.startsWith('command:SessionStart'),
  );

  return [
    `Q1 PreCompact fired:                 ${mark(findings.preCompactFired)}`,
    `   transcript readable at that time: ${mark(findings.transcriptReadableAtPreCompact)} (${findings.transcriptTailChars} chars)`,
    `Q2 SessionStart:compact fired:       ${mark(findings.sessionStartCompactFired)}`,
    `Q3 injected text reached the model:  ${findings.injectionVerdict.toUpperCase()}`,
    `   nonce:  ${findings.nonce}`,
    `   answer: ${findings.answer.trim().slice(0, 200)}`,
    '',
    `SessionStart over command hook:      ${mark(sawSessionStartOverCommand)}`,
    `SessionStart over http hook:         ${mark(sawSessionStartOverHttp)}`,
    '',
    VIABILITY_MESSAGE[viability(findings)],
  ].join('\n');
}
