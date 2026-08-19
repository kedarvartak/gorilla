import { asRecord, numberOr } from '../json.js';
import type { ExtractionWindow, WindowTrigger } from './window.js';

/**
 * The model call, and only the model call (doc 08).
 *
 * The pipeline talks to an `ExtractionModel`, never to HTTP. That is not
 * ceremony: it means every rule in validate.ts is testable without an API key,
 * and it means a run with no key degrades to mechanical extraction rather than
 * failing (P7).
 */

/** The small fast model doc 08 specifies for routine turn extraction. */
export const DEFAULT_FAST_MODEL = 'claude-haiku-4-5-20251001';

/** Used for irreplaceable windows when the card names no `synthesisModel`. */
export const DEFAULT_SYNTHESIS_MODEL = 'claude-sonnet-5';

export interface ModelChoice {
  readonly model: string;
  readonly escalated: boolean;
  readonly reason: string;
}

/**
 * Small and fast by default; escalate where the content is irreplaceable.
 *
 * A `PreCompact` window is the one place a cheap miss cannot be recovered by
 * re-extracting later, because the material itself is gone. That asymmetry, not
 * the size of the window, is what justifies the more expensive model.
 */
export function chooseModel(input: {
  trigger: WindowTrigger;
  synthesisModel?: string | null;
  fastModel?: string;
}): ModelChoice {
  const escalate = input.trigger === 'PreCompact' || input.trigger === 'manual';

  if (escalate) {
    return {
      model: input.synthesisModel ?? DEFAULT_SYNTHESIS_MODEL,
      escalated: true,
      reason:
        input.trigger === 'PreCompact'
          ? 'the window is about to be discarded and cannot be re-read'
          : 'the operator asked for this one',
    };
  }

  return {
    model: input.fastModel ?? DEFAULT_FAST_MODEL,
    escalated: false,
    reason: 'routine turn extraction',
  };
}

/** One entry exactly as the model returned it. Nothing here is trusted yet. */
export interface RawEntry {
  readonly kind?: unknown;
  readonly statement?: unknown;
  readonly detail?: unknown;
  readonly alternative?: unknown;
  readonly sourceEventIds?: unknown;
  readonly filePaths?: unknown;
  readonly confidence?: unknown;
}

export interface ModelUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface ExtractionRequest {
  readonly model: string;
  readonly system: string;
  readonly prompt: string;
  readonly maxTokens: number;
}

export interface ExtractionResponse {
  readonly entries: readonly RawEntry[];
  readonly usage: ModelUsage;
}

export type ExtractionModel = (request: ExtractionRequest) => Promise<ExtractionResponse>;

/**
 * The instructions, kept deliberately short.
 *
 * The constraints here are doc 08's, minus the ones enforced in code. A rule
 * the validator enforces does not need to be argued for in the prompt as well:
 * stating it once helps, restating it three ways spends tokens on every call
 * for a guarantee we already have.
 */
export const EXTRACTION_SYSTEM = [
  'You read a slice of an autonomous coding session and record what a competent engineer',
  'who was absent would need to know. You are not summarising; you are keeping the',
  'reasoning that the event log cannot show.',
  '',
  'Rules:',
  '- One sentence per statement. Supporting matter goes in detail.',
  '- decision: name the alternative that was not taken. Without one it is not a decision.',
  '- assumption: something believed but not verified by tool output in this window.',
  '- risk: a failure, refusal, or hazard. question: something needing human judgement.',
  '- Never restate the diff. File edits are already recorded from tool events.',
  '- Cite the #id of every event a statement rests on.',
  '- Emit nothing rather than filler. An empty list is the right answer for a',
  '  mechanical turn, and volume is not rewarded.',
].join('\n');

export function buildPrompt(window: ExtractionWindow): string {
  return [
    `Trigger: ${window.trigger}`,
    window.trigger === 'PreCompact'
      ? 'This context is about to be discarded. It will not be readable again.'
      : '',
    '',
    window.text,
  ]
    .filter((line) => line !== '')
    .join('\n');
}

/** The JSON schema the model is forced to fill. Mirrors LedgerEntry, minus provenance. */
export const EXTRACTION_TOOL = {
  name: 'record_entries',
  description: 'Record the ledger entries for this window. Pass an empty array if there are none.',
  input_schema: {
    type: 'object',
    properties: {
      entries: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: ['decision', 'assumption', 'risk', 'question'] },
            statement: { type: 'string' },
            detail: { type: 'string' },
            alternative: { type: 'string', description: 'Required for kind=decision.' },
            sourceEventIds: { type: 'array', items: { type: 'integer' } },
            filePaths: { type: 'array', items: { type: 'string' } },
            confidence: { type: 'number' },
          },
          required: ['kind', 'statement', 'sourceEventIds'],
        },
      },
    },
    required: ['entries'],
  },
} as const;

export interface AnthropicOptions {
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly fetch?: typeof fetch;
}

/**
 * The real client, written against the Messages API directly rather than
 * through an SDK: one POST, no dependency, and nothing to keep in step.
 *
 * Structured output is a forced tool call, which is what makes the response
 * shape a guarantee rather than a parsing exercise.
 */
export function anthropicExtractionModel(options: AnthropicOptions): ExtractionModel {
  const doFetch = options.fetch ?? fetch;
  const baseUrl = options.baseUrl ?? 'https://api.anthropic.com';

  return async (request) => {
    const response = await doFetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': options.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: request.model,
        max_tokens: request.maxTokens,
        system: request.system,
        messages: [{ role: 'user', content: request.prompt }],
        tools: [EXTRACTION_TOOL],
        tool_choice: { type: 'tool', name: EXTRACTION_TOOL.name },
      }),
    });

    if (!response.ok) {
      throw new Error(`extraction call failed: ${response.status} ${await response.text()}`);
    }

    return parseAnthropicResponse(await response.json());
  };
}

/** Exported for the tests, which is the only way to check a wire shape offline. */
export function parseAnthropicResponse(body: unknown): ExtractionResponse {
  const record = asRecord(body);
  const usageRecord = asRecord(record?.['usage']);
  const usage: ModelUsage = {
    inputTokens: numberOr(usageRecord?.['input_tokens'], 0),
    outputTokens: numberOr(usageRecord?.['output_tokens'], 0),
  };

  const content = record?.['content'];
  if (!Array.isArray(content)) return { entries: [], usage };

  for (const block of content) {
    const blockRecord = asRecord(block);
    if (blockRecord?.['type'] !== 'tool_use' || blockRecord['name'] !== EXTRACTION_TOOL.name) {
      continue;
    }
    const entries = asRecord(blockRecord['input'])?.['entries'];
    if (Array.isArray(entries)) return { entries: entries as RawEntry[], usage };
  }

  return { entries: [], usage };
}
