/**
 * Redaction for recorded fixtures.
 *
 * Hook payloads carry file contents, command output and prompt text. A fixture
 * is a file that gets committed, shared in a bug report, or replayed on another
 * machine, so recording one unredacted is a way to leak source code and
 * whatever appeared in shell output - which routinely includes secrets
 * (doc 11, security).
 *
 * Redaction preserves shape and size and destroys content, so a redacted
 * fixture still exercises the same code paths and produces the same event
 * count and ordering.
 */

/**
 * Payload paths whose values are content rather than structure. Matched at any
 * depth by key name, because tool payloads nest differently per tool and an
 * exhaustive path list would silently miss new ones.
 */
const CONTENT_KEYS = new Set([
  'command',
  'content',
  'edits',
  'expanded_prompt',
  'file_text',
  'last_assistant_message',
  'message_text',
  'new_string',
  'old_string',
  'oldString',
  'newString',
  'output',
  'prompt',
  'prompt_text',
  'stderr',
  'stdout',
  'text',
  'tool_error',
  'user_input',
  'user_response',
  'task_description',
]);

/** Keys that identify rather than describe, and must survive redaction. */
const PRESERVED_KEYS = new Set([
  'agent_id',
  'agent_type',
  'cwd',
  'event',
  'hook_event_name',
  'permission_mode',
  'prompt_id',
  'session_id',
  'tool_name',
  'tool_use_id',
  'transcript_path',
  'trigger_reason',
  'notification_type',
  'end_reason',
  'error_type',
  'load_reason',
  'task_id',
  'task_name',
]);

function redactString(value: string): string {
  return `[redacted ${value.length} chars]`;
}

function redactValue(value: unknown, keyIsContent: boolean): unknown {
  if (typeof value === 'string') {
    return keyIsContent ? redactString(value) : value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, keyIsContent));
  }
  if (typeof value === 'object' && value !== null) {
    return redactObject(value as Record<string, unknown>);
  }
  return value;
}

function redactObject(source: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(source)) {
    if (PRESERVED_KEYS.has(key)) {
      output[key] = value;
      continue;
    }
    output[key] = redactValue(value, CONTENT_KEYS.has(key));
  }

  return output;
}

/**
 * Returns a copy with content values replaced by length markers. Identifiers,
 * paths and structure are preserved so replay behaves identically.
 */
export function redactPayload(payload: unknown): unknown {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return payload;
  }
  return redactObject(payload as Record<string, unknown>);
}

export const REDACTED_CONTENT_KEYS: readonly string[] = [...CONTENT_KEYS];
