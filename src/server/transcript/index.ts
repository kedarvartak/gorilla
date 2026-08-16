/**
 * The transcript module boundary (doc 06, P7).
 *
 * The transcript format is internal to Claude Code and changes between
 * versions, so it is graded an enrichment source only: every core feature must
 * work without it. Nothing outside this directory may import the internals -
 * this barrel is the contract, and it is deliberately narrow so a format change
 * is contained to one module.
 */

export {
  DEFAULT_CONTEXT_WINDOW,
  readTailWindow,
  readTranscript,
  utilizationFor,
  type DriftReport,
  type TranscriptSummary,
  type Utilization,
} from './reader.js';

export { TranscriptTail, type TailOptions } from './tail.js';

export {
  isKnownRecordType,
  KNOWN_RECORD_TYPES,
  type AssistantRecord,
  type TokenUsage,
  type TranscriptRecord,
  type UserRecord,
} from './records.js';

export { findTranscripts, transcriptDirForCwd } from './locate.js';
