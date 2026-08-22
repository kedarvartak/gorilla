import { describe, expect, it } from 'vitest';

import { describe as describeStamp, TOLERANCE_MS } from '../src/server/web/stamp.js';

/**
 * Whether the interface being served was built from this server's source
 * (T1, T2).
 *
 * The failure has happened twice: a server keeps running from an old build,
 * the browser holds the old bundle, every new endpoint 404s, and the board
 * looks healthy. Nothing could tell, because what the server serves and what
 * the bundle expects were never compared with each other.
 */

const MINUTE = 60_000;

describe('comparing the two builds', () => {
  it('says nothing when they were built together', () => {
    const now = Date.now();

    // tsc and vite run in sequence and finish seconds apart, in that order, so
    // the interface is always marginally older than its server. Reporting that
    // would cry wolf on every single build.
    expect(describeStamp(now - 5_000, now).stale).toBe(false);
    expect(describeStamp(now - 5_000, now).note).toBeNull();
  });

  it('says so when the interface is well behind', () => {
    const now = Date.now();
    const stamp = describeStamp(now - 40 * MINUTE, now);

    expect(stamp.stale).toBe(true);
    expect(stamp.note).toContain('40 minute');
  });

  it('tells the operator what to do about it', () => {
    const stamp = describeStamp(Date.now() - 40 * MINUTE, Date.now());

    // A warning nobody can act on is noise, and this one has exactly one fix.
    expect(stamp.note).toContain('npm run build');
  });

  it('says nothing when running from source', () => {
    // No second artefact to disagree with. Inventing a warning here would
    // train the operator to dismiss the one that matters.
    expect(describeStamp(null, Date.now()).stale).toBe(false);
    expect(describeStamp(Date.now(), null).stale).toBe(false);
    expect(describeStamp(null, null).note).toBeNull();
  });

  it('is not upset by an interface newer than its server', () => {
    // `vite build` alone, without tsc, is a normal thing to do while working
    // on the interface, and it does not make the server out of date.
    expect(describeStamp(Date.now(), Date.now() - 40 * MINUTE).stale).toBe(false);
  });

  it('holds the line exactly at the tolerance', () => {
    const now = Date.now();

    expect(describeStamp(now - TOLERANCE_MS, now).stale).toBe(false);
    expect(describeStamp(now - TOLERANCE_MS - 1, now).stale).toBe(true);
  });
});
