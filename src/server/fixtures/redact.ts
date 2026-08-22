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

/**
 * Keys whose value is a credential whatever else it is.
 *
 * The content list above is an allowlist of things that are *long*. A secret
 * is short, so it was not on it - and a key called `ANTHROPIC_API_KEY` is
 * neither content nor preserved, which meant its value passed through a
 * redacted fixture verbatim. Found by a test written for T66, which makes
 * fixtures far easier to produce and so raises what that costs.
 */
const SECRET_KEYS = /(^|[_-])(api_?key|token|secret|password|passwd|credential|auth|authorization)([_-]|$)/i;

/**
 * Shapes that are a credential wherever they appear.
 *
 * Matched on the value, because a secret pasted into a command line or printed
 * by a tool is not under a helpfully named key. Deliberately specific prefixes
 * rather than an entropy guess: redacting anything that looks random would eat
 * commit hashes, uuids and base64 file content, and a fixture with its
 * identifiers destroyed does not replay.
 */
const SECRET_VALUES: readonly RegExp[] = [
  /sk-[A-Za-z0-9_-]{16,}/g,
  /ghp_[A-Za-z0-9]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /xox[baprs]-[A-Za-z0-9-]{10,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /\bBearer\s+[A-Za-z0-9._-]{20,}/gi,
];

function redactString(value: string): string {
  return `[redacted ${value.length} chars]`;
}

/** Replaces credential-shaped runs inside an otherwise ordinary string. */
function scrub(value: string): string {
  let scrubbed = value;
  for (const pattern of SECRET_VALUES) scrubbed = scrubbed.replace(pattern, '[redacted secret]');
  return scrubbed;
}

function redactValue(value: unknown, keyIsContent: boolean, keyIsSecret = false): unknown {
  if (typeof value === 'string') {
    if (keyIsSecret) return redactString(value);
    return keyIsContent ? redactString(value) : scrub(value);
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
    output[key] = redactValue(value, CONTENT_KEYS.has(key), SECRET_KEYS.test(key));
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
