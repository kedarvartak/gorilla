/**
 * Permissive readers for data the board did not write (doc 02, R7).
 *
 * Hook payloads, transcript records and API responses all arrive shaped by
 * something outside this codebase, and every one of them can change without
 * notice. So nothing here throws: a missing field, a wrong type, or a body that
 * will not parse degrades what the caller can say rather than failing the
 * request. The event is evidence even when its shape is not what we expected.
 *
 * These existed six times over - in `store.ts`, `window.ts`, `mechanical.ts`,
 * `model.ts`, `cli-model.ts` and `lifecycle.ts`, with three different names for
 * the same idea and small differences nobody intended. Six copies of a rule
 * about trusting foreign data is six places for the rule to drift, and the
 * differences are invisible until one of them behaves unlike the others.
 */

/** An object, or null. Arrays are not records: indexing one by name is a bug. */
export function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** An object, or an empty one, for callers that only ever read fields. */
export function recordOr(value: unknown): Record<string, unknown> {
  return asRecord(value) ?? {};
}

/**
 * A non-empty string field, or null.
 *
 * Empty counts as absent throughout the board: a tool name of `''` or a reason
 * of `''` carries no more than a missing one, and treating them differently
 * would mean every caller checking twice.
 */
export function readString(source: unknown, key: string): string | null {
  const value = asRecord(source)?.[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

/** A finite number field, or the fallback. NaN and Infinity count as absent. */
export function readNumber(source: unknown, key: string, fallback: number): number {
  const value = asRecord(source)?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** A stored JSON object column, parsed. Unparseable is empty, never a throw. */
export function parseObject(raw: string): Record<string, unknown> {
  try {
    return recordOr(JSON.parse(raw));
  } catch {
    return {};
  }
}

/** A stored JSON array column, parsed. Unparseable or non-array is empty. */
export function parseArray(raw: string): unknown[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** The elements of a stored JSON array that are strings. */
export function parseStrings(raw: string): string[] {
  return parseArray(raw).filter((value): value is string => typeof value === 'string');
}

/** The elements of a stored JSON array that are numbers. */
export function parseNumbers(raw: string): number[] {
  return parseArray(raw).filter((value): value is number => typeof value === 'number');
}

/** A hook payload's `tool_input`, which is where paths and commands live. */
export function toolInput(payload: unknown): Record<string, unknown> {
  return recordOr(asRecord(payload)?.['tool_input']);
}

/**
 * The file a tool event names.
 *
 * Three spellings because three tools use three: `file_path` from Edit and
 * Write, `filePath` from some notebook operations, `path` from others. Reading
 * only one of them silently loses a third of the blast radius.
 */
export function toolPath(payload: unknown): string | null {
  const input = toolInput(payload);
  return (
    readString(input, 'file_path') ?? readString(input, 'filePath') ?? readString(input, 'path')
  );
}
