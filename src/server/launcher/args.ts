import {
  describeGuardrails,
  prohibitionIsExpressible,
  type GuardrailSet,
} from '../cards/guardrails.js';
import { isEmpty, type CardBackground } from '../cards/background.js';

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

/** Arguments for the Codex CLI's non-interactive JSON stream. */
export function buildCodexArgs(spec: LaunchSpec, context: string): string[] {
  const prompt = [composePrompt(spec), context].filter((part) => part.trim() !== '').join('\n\n');
  const args = ['exec', '--json', '--full-auto'];
  if (spec.agentModel !== null && spec.agentModel !== undefined && spec.agentModel !== '') {
    args.push('--model', spec.agentModel);
  }
  args.push(prompt);
  return args;
}

export interface CardContextInput {
  /** The card's own branch, when it has an isolated worktree. */
  readonly branch?: string | null;
  /** Rules true of the project rather than of this card (doc 12, output 2). */
  readonly invariants?: readonly string[];
  readonly title: string;
  readonly body: string;
  readonly guardrails: GuardrailSet;
  /** Ledger entries the operator has accepted or promoted (Phase 2 onward). */
  readonly acceptedEntries?: readonly string[];
  /**
   * Ledger entries the operator has rejected. Sent so the next run does not
   * re-arrive at a claim already overruled - the whole point of a two-way
   * sync loop rather than a one-way report (P5).
   */
  readonly rejectedEntries?: readonly string[];
  /** What previous runs on this card established. */
  readonly previousRuns?: readonly string[];
  /**
   * What the board already knows about this work (T13, T16, T18, T19).
   *
   * Placed below the constraints and above the ledger: constraints bound what
   * the agent may do and have to be read first, and the ledger is this card's
   * own history, which outranks anything inferred from its neighbours.
   */
  readonly background?: CardBackground | null;
  /**
   * What the operator said when they sent the card back (T22).
   *
   * Placed above everything the model established, because it is the operator
   * overruling the last run and the agent must not have to weigh it against a
   * claim the run made about itself.
   */
  readonly operatorNote?: string | null;
}

/**
 * The background block.
 *
 * Written as facts with their provenance attached rather than as
 * instructions. An agent handed "these files are related" will edit them; an
 * agent handed "card X changed these same files" will read X's work first,
 * which is the behaviour this is for. Every heading says where the fact came
 * from, because a claim whose source is invisible gets weighted as though the
 * board were certain of it.
 */
function renderBackground(background: CardBackground): string[] {
  const lines: string[] = [
    '## What the board already knows about this work',
    '',
    'Assembled from what earlier cards on this board actually did. It is',
    'context, not instruction: none of it overrides the constraints above.',
    '',
  ];

  if (background.waitingOn.length > 0) {
    // First, because it changes whether the work should start at all.
    lines.push(
      '### This card is waiting on other cards',
      '',
      ...background.waitingOn.map((entry) => `- ${entry}`),
      '',
      'They are not finished. Expect what they are changing to be absent or in flux.',
      '',
    );
  }

  if (background.contradictions.length > 0) {
    lines.push(
      '### This card runs into a project rule',
      '',
      ...background.contradictions.map((entry) => `- ${entry}`),
      '',
      'Not necessarily a mistake - a rule can prohibit a path precisely because',
      'this card is the one allowed to change it. Say which reading you took.',
      '',
    );
  }

  if (background.previousRuns.length > 0) {
    lines.push(
      '### Previous runs on this card',
      '',
      ...background.previousRuns.map((entry) => `- ${entry}`),
      '',
    );
  }

  if (background.touched.length > 0) {
    lines.push(
      '### What this card has already touched',
      '',
      ...background.touched.map((entry) => `- ${entry}`),
      '',
    );
  }

  if (background.related.length > 0) {
    lines.push(
      '### Earlier cards that changed the same files',
      '',
      ...background.related.map(
        (card) => `- "${card.title}" - ${card.shared.slice(0, 6).join(', ')}`,
      ),
      '',
      'Read what they did before changing those files. Whatever they concluded',
      'about that code is probably still true, and rediscovering it costs a run.',
      '',
    );
  }

  if (background.blastRadius !== null) {
    lines.push('### Where similar work has landed before', '', background.blastRadius, '');
  }

  return lines;
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

  if (input.branch !== undefined && input.branch !== null && input.branch !== '') {
    // Said plainly because it was not said at all, and agents cannot be
    // expected to infer that their working directory is a throwaway worktree
    // whose contents reach nobody until they are committed.
    lines.push(
      '## Your branch',
      '',
      `You are working in an isolated git worktree on the branch \`${input.branch}\`.`,
      'Nothing you write reaches anyone until it is committed to that branch.',
      'Commit your work before you finish, in whatever pieces make sense.',
      'Do not merge, rebase, push, or switch branches - the board does that after review.',
      '',
    );
  }

  if (input.invariants !== undefined && input.invariants.length > 0) {
    // Separated from the card's own constraints on purpose. An agent that
    // cannot tell a project rule from a card rule will either treat a standing
    // rule as this task's peculiarity, or treat this task's peculiarity as a
    // standing rule and carry it into the next card.
    lines.push(
      '## Rules for this project, true of every card',
      '',
      ...input.invariants.map((rule) => `- ${rule}`),
      '',
    );
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

  if (input.background !== undefined && input.background !== null && !isEmpty(input.background)) {
    lines.push(...renderBackground(input.background));
  }

  if (
    input.operatorNote !== undefined &&
    input.operatorNote !== null &&
    input.operatorNote.trim() !== ''
  ) {
    // Before the ledger sections deliberately. This is a person overruling the
    // last run, and an agent should not have to weigh it against a claim that
    // run made about itself.
    lines.push(
      '## The operator sent this card back',
      '',
      input.operatorNote.trim(),
      '',
      'This is an instruction from the person who owns this work. It outranks',
      'anything a previous run on this card concluded.',
      '',
    );
  }

  if (input.acceptedEntries !== undefined && input.acceptedEntries.length > 0) {
    lines.push('## Established on this card', '');
    for (const entry of input.acceptedEntries) lines.push(`- ${entry}`);
    lines.push('');
  }

  if (input.rejectedEntries !== undefined && input.rejectedEntries.length > 0) {
    // Marked overruled, not omitted: a run that never sees the rejection is a
    // run that can re-propose the same claim and cost the operator a second
    // review of something they already answered.
    lines.push('## Overruled by the operator', '');
    for (const entry of input.rejectedEntries) lines.push(`- ${entry} (overruled by the operator)`);
    lines.push('');
  }

  if (input.previousRuns !== undefined && input.previousRuns.length > 0) {
    lines.push('## Previous runs', '');
    for (const run of input.previousRuns) lines.push(`- ${run}`);
    lines.push('');
  }

  return `${lines.join('\n').trimEnd()}\n`;
}
