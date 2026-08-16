import {
  describeGuardrails,
  prohibitionIsExpressible,
  type GuardrailSet,
} from '../cards/guardrails.js';

/**
 * Translating a card into `claude -p` arguments (doc 07 section 3).
 *
 * Pure, and separated from process handling on purpose: this is the part where
 * a mistake means a card's restrictions silently do not apply, which is a
 * failure the operator cannot see. It should be testable without spawning
 * anything.
 */

export interface LaunchSpec {
  readonly goalCondition: string | null;
  readonly guardrails: GuardrailSet;
  readonly agentModel?: string | null;
  readonly agentEffort?: string | null;
  readonly permissionMode?: string | null;
  readonly contextFilePath?: string | null;
  readonly settingsPath?: string | null;
  readonly resumeSessionId?: string | null;
  /** Free-form instruction used when the card has no goal condition. */
  readonly prompt?: string | null;
}

/**
 * A card with no goal condition still needs something to do. Falling back to
 * the card body is better than refusing, but the caller should have composed a
 * condition first (P5).
 */
export function composePrompt(spec: LaunchSpec): string {
  if (spec.goalCondition !== null && spec.goalCondition.trim() !== '') {
    return `/goal ${spec.goalCondition.trim()}`;
  }
  return (spec.prompt ?? '').trim();
}

/**
 * Deny rules from the prohibitions that can actually be expressed.
 *
 * Only expressible prohibitions become rules. An advisory prohibition must not
 * silently turn into a rule that does not match what the operator meant - a
 * deny rule that matches nothing is worse than no rule, because it looks like
 * protection.
 */
export function denyRulesFor(guardrails: GuardrailSet): string[] {
  return guardrails.prohibit
    .filter((rule) => prohibitionIsExpressible(rule))
    .map((rule) => {
      const trimmed = rule.trim();
      // Already a tool-scoped rule such as Bash(git push *).
      if (/^[A-Za-z][\w.-]*\([^)]*\)$/.test(trimmed)) return trimmed;
      // A path: deny every mutating tool against it.
      return `Edit(${trimmed})`;
    });
}

/**
 * A settings overlay carrying the deny rules, passed with `--settings` so the
 * rules apply to this card's session and nothing else.
 *
 * Never written into the project's settings file: a card's restrictions must
 * not leak into every other session in the repository (doc 07 section 3).
 */
export function settingsOverlay(guardrails: GuardrailSet): Record<string, unknown> {
  const deny = denyRulesFor(guardrails);

  const overlay: Record<string, unknown> = {};
  if (deny.length > 0) {
    overlay['permissions'] = { deny };
  }
  return overlay;
}

export function buildArgs(spec: LaunchSpec): string[] {
  const args: string[] = ['-p', composePrompt(spec)];

  args.push('--output-format', 'stream-json', '--verbose');

  if (spec.resumeSessionId !== null && spec.resumeSessionId !== undefined) {
    args.push('--resume', spec.resumeSessionId);
  }
  if (spec.agentModel !== null && spec.agentModel !== undefined && spec.agentModel !== '') {
    args.push('--model', spec.agentModel);
  }
  if (spec.agentEffort !== null && spec.agentEffort !== undefined && spec.agentEffort !== '') {
    args.push('--effort', spec.agentEffort);
  }
  if (
    spec.permissionMode !== null &&
    spec.permissionMode !== undefined &&
    spec.permissionMode !== ''
  ) {
    args.push('--permission-mode', spec.permissionMode);
  }
  if (spec.guardrails.allowTools.length > 0) {
    args.push('--allowedTools', spec.guardrails.allowTools.join(','));
  }
  if (spec.contextFilePath !== null && spec.contextFilePath !== undefined) {
    args.push('--append-system-prompt-file', spec.contextFilePath);
  }
  if (spec.settingsPath !== null && spec.settingsPath !== undefined) {
    args.push('--settings', spec.settingsPath);
  }

  return args;
}

export interface CardContextInput {
  readonly title: string;
  readonly body: string;
  readonly guardrails: GuardrailSet;
  /** Ledger entries the operator has accepted or promoted (Phase 2 onward). */
  readonly acceptedEntries?: readonly string[];
  /** What previous runs on this card established. */
  readonly previousRuns?: readonly string[];
}

/**
 * The `card-context.md` handed to the session.
 *
 * The outbound half of the context loop: the card is not a label on the work,
 * it is an input to it (doc 07 section 3). Advisory guardrails are stated as
 * instructions here precisely because nothing else will enforce them.
 */
export function renderCardContext(input: CardContextInput): string {
  const lines: string[] = [`# Card: ${input.title}`, ''];

  if (input.body.trim() !== '') {
    lines.push(input.body.trim(), '');
  }

  const described = describeGuardrails(input.guardrails);
  if (described.length > 0) {
    lines.push('## Constraints', '');
    for (const guardrail of described) {
      // Hard rules are marked so the agent knows which will simply fail, and
      // advisory ones are marked so it knows which rest on its cooperation.
      lines.push(`- ${guardrail.text} (${guardrail.enforcement})`);
    }
    lines.push('');
  }

  if (input.acceptedEntries !== undefined && input.acceptedEntries.length > 0) {
    lines.push('## Established on this card', '');
    for (const entry of input.acceptedEntries) lines.push(`- ${entry}`);
    lines.push('');
  }

  if (input.previousRuns !== undefined && input.previousRuns.length > 0) {
    lines.push('## Previous runs', '');
    for (const run of input.previousRuns) lines.push(`- ${run}`);
    lines.push('');
  }

  return `${lines.join('\n').trimEnd()}\n`;
}
