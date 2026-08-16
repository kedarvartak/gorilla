/**
 * Permissive parsing of Claude Code transcript records.
 *
 * The transcript format is internal to Claude Code and documented as changing
 * between versions (doc 02, surface B). Everything here is therefore written to
 * degrade rather than fail: unknown record types are counted, unexpected shapes
 * are ignored, and no input - truncated, corrupt, or from a future release -
 * may throw.
 *
 * Nothing outside src/server/transcript/ should import this file. The barrel in
 * index.ts is the boundary (doc 06, P7).
 */

/**
 * Record types observed in real transcripts on Claude Code 2.x. This list is
 * evidence, not specification: a type absent from it is reported as drift, not
 * treated as an error.
 */
export const KNOWN_RECORD_TYPES = [
  'assistant',
  'attachment',
  'ai-title',
  'bridge-session',
  'file-history-delta',
  'file-history-snapshot',
  'frame-link',
  'last-prompt',
  'mode',
  'permission-mode',
  'pr-link',
  'queue-operation',
  'summary',
  'system',
  'user',
] as const;

const KNOWN = new Set<string>(KNOWN_RECORD_TYPES);

/** A model id Claude Code uses for messages it generated without an API call. */
const SYNTHETIC_MODEL = '<synthetic>';

export interface TokenUsage {
  readonly inputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheCreationTokens: number;
  readonly outputTokens: number;
  readonly thinkingTokens: number;
  /**
   * Everything the model had to attend to on this request: fresh input plus
   * both cache classes. This is the figure the utilization gauge uses.
   */
  readonly contextTokens: number;
}

export interface AssistantRecord {
  readonly kind: 'assistant';
  readonly uuid: string | null;
  readonly timestamp: string | null;
  readonly model: string | null;
  readonly synthetic: boolean;
  readonly text: string;
  readonly thinking: string;
  readonly toolNames: readonly string[];
  readonly usage: TokenUsage | null;
}

export interface UserRecord {
  readonly kind: 'user';
  readonly uuid: string | null;
  readonly timestamp: string | null;
  readonly text: string;
  readonly gitBranch: string | null;
  readonly cwd: string | null;
}

export interface OtherRecord {
  readonly kind: 'other';
  readonly type: string;
  readonly known: boolean;
}

export type TranscriptRecord = AssistantRecord | UserRecord | OtherRecord;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(source: Record<string, unknown> | null, key: string): string | null {
  if (source === null) return null;
  const value = source[key];
  return typeof value === 'string' ? value : null;
}

function readNumber(source: Record<string, unknown> | null, key: string): number {
  if (source === null) return 0;
  const value = source[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function parseUsage(usage: Record<string, unknown> | null): TokenUsage | null {
  if (usage === null) return null;

  const inputTokens = readNumber(usage, 'input_tokens');
  const cacheReadTokens = readNumber(usage, 'cache_read_input_tokens');
  const cacheCreationTokens = readNumber(usage, 'cache_creation_input_tokens');
  const outputTokens = readNumber(usage, 'output_tokens');
  const thinkingTokens = readNumber(asRecord(usage['output_tokens_details']), 'thinking_tokens');

  return {
    inputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    outputTokens,
    thinkingTokens,
    contextTokens: inputTokens + cacheReadTokens + cacheCreationTokens,
  };
}

/**
 * Content blocks are `text`, `thinking`, `tool_use` and `tool_result`, but a
 * future release may add others. Unknown block types contribute nothing rather
 * than breaking extraction.
 */
function parseContent(content: unknown): {
  text: string;
  thinking: string;
  toolNames: string[];
} {
  const text: string[] = [];
  const thinking: string[] = [];
  const toolNames: string[] = [];

  if (typeof content === 'string') return { text: content, thinking: '', toolNames: [] };
  if (!Array.isArray(content)) return { text: '', thinking: '', toolNames: [] };

  for (const raw of content) {
    const block = asRecord(raw);
    if (block === null) continue;

    switch (block['type']) {
      case 'text': {
        const value = readString(block, 'text');
        if (value !== null) text.push(value);
        break;
      }
      case 'thinking': {
        const value = readString(block, 'thinking');
        if (value !== null) thinking.push(value);
        break;
      }
      case 'tool_use': {
        const name = readString(block, 'name');
        if (name !== null) toolNames.push(name);
        break;
      }
      default:
        break;
    }
  }

  return { text: text.join('\n'), thinking: thinking.join('\n'), toolNames };
}

/**
 * Parses one line. Returns null for blank lines and for anything that is not
 * JSON - a truncated final line while the file is being appended to is normal,
 * not exceptional.
 */
export function parseLine(line: string): TranscriptRecord | null {
  const trimmed = line.trim();
  if (trimmed === '') return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }

  const record = asRecord(parsed);
  if (record === null) return null;

  const type = readString(record, 'type');
  if (type === null) return { kind: 'other', type: 'untyped', known: false };

  if (type === 'assistant') {
    const message = asRecord(record['message']);
    const model = readString(message, 'model');
    const { text, thinking, toolNames } = parseContent(message?.['content']);

    return {
      kind: 'assistant',
      uuid: readString(record, 'uuid'),
      timestamp: readString(record, 'timestamp'),
      model,
      synthetic: model === SYNTHETIC_MODEL,
      text,
      thinking,
      toolNames,
      usage: parseUsage(asRecord(message?.['usage'])),
    };
  }

  if (type === 'user') {
    const message = asRecord(record['message']);
    const { text } = parseContent(message?.['content']);

    return {
      kind: 'user',
      uuid: readString(record, 'uuid'),
      timestamp: readString(record, 'timestamp'),
      text,
      gitBranch: readString(record, 'gitBranch'),
      cwd: readString(record, 'cwd'),
    };
  }

  return { kind: 'other', type, known: KNOWN.has(type) };
}

export function isKnownRecordType(type: string): boolean {
  return KNOWN.has(type);
}
