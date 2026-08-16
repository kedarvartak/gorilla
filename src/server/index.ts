/**
 * Server entry point.
 *
 * The hook ingest endpoint (T3), the SSE stream (T6), and the storage layer
 * (T2) attach here. Phase 0 keeps this deliberately empty so the scaffold task
 * ships no application logic.
 */

/** Default port. Bound to loopback only - transcripts contain source code. */
export const DEFAULT_PORT = 4300;
export const DEFAULT_HOST = '127.0.0.1';
