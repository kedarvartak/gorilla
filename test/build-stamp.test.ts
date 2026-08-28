import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  describe as describeStamp,
  readBuildStamp,
  runningServerBuiltAt,
  TOLERANCE_MS,
} from '../src/server/web/stamp.js';

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

  it('says so when the interface is ahead of the server running it', () => {
    // The half that actually 404s, and the half this used to call healthy
    // (T80). The bundle in the browser calls routes this process was never
    // loaded with; no amount of rebuilding fixes it, only a restart.
    const now = Date.now();
    const stamp = describeStamp(now, now - 40 * MINUTE);

    expect(stamp.stale).toBe(true);
    expect(stamp.direction).toBe('server-behind');
    expect(stamp.note).toContain('40 minute');
    expect(stamp.note).toContain('404');
    expect(stamp.note).toContain('Restart');
  });

  it('names which side is behind', () => {
    const now = Date.now();

    expect(describeStamp(now - 40 * MINUTE, now).direction).toBe('interface-behind');
    expect(describeStamp(now, now - 40 * MINUTE).direction).toBe('server-behind');
    expect(describeStamp(now, now).direction).toBeNull();
  });

  it('holds the line exactly at the tolerance, both ways', () => {
    const now = Date.now();

    expect(describeStamp(now - TOLERANCE_MS, now).stale).toBe(false);
    expect(describeStamp(now - TOLERANCE_MS - 1, now).stale).toBe(true);

    // `tsc` runs before `vite build`, so a healthy build always leaves the
    // interface seconds newer than its server. The tolerance has to be
    // symmetric or every clean build would trip the second direction.
    expect(describeStamp(now, now - TOLERANCE_MS).stale).toBe(false);
    expect(describeStamp(now, now - TOLERANCE_MS - 1).stale).toBe(true);
  });
});

describe('comparing against the running process', () => {
  let root = '';

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'build-stamp-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /** A tree shaped like the one the stamp resolves against, with `dist/`. */
  function laidOut(input: {
    readonly webBuiltAt: number;
    readonly serverOnDiskAt: number;
  }): string {
    const here = join(root, 'src/server/web');
    mkdirSync(here, { recursive: true });

    mkdirSync(join(root, 'dist/web'), { recursive: true });
    const index = join(root, 'dist/web/index.html');
    writeFileSync(index, '<!doctype html>');
    utimesSync(index, input.webBuiltAt / 1000, input.webBuiltAt / 1000);

    mkdirSync(join(root, 'dist/server'), { recursive: true });
    const app = join(root, 'dist/server/app.js');
    writeFileSync(app, '');
    utimesSync(app, input.serverOnDiskAt / 1000, input.serverOnDiskAt / 1000);

    return here;
  }

  it('reports stale when the server was rebuilt but never restarted', () => {
    const now = Date.now();

    // The whole point of T80. `npm run build` has just rewritten both halves
    // of `dist/`, so a stamp that stats files on disk sees two fresh artefacts
    // and says everything is fine - while the process still serving requests
    // was loaded 40 minutes ago and 404s every route added since.
    const here = laidOut({ webBuiltAt: now, serverOnDiskAt: now });
    const stamp = readBuildStamp(here, now - 40 * MINUTE);

    expect(stamp.stale).toBe(true);
    expect(stamp.direction).toBe('server-behind');
    expect(stamp.serverBuiltAt).toBe(now - 40 * MINUTE);
  });

  it('is quiet when the running process matches what is built', () => {
    const now = Date.now();
    const here = laidOut({ webBuiltAt: now, serverOnDiskAt: now });

    expect(readBuildStamp(here, now - 5_000).stale).toBe(false);
  });

  it('still catches an interface left behind', () => {
    const now = Date.now();
    const here = laidOut({ webBuiltAt: now - 40 * MINUTE, serverOnDiskAt: now });
    const stamp = readBuildStamp(here, now);

    expect(stamp.stale).toBe(true);
    expect(stamp.direction).toBe('interface-behind');
  });

  it('dates the server from source as unbuilt', () => {
    // These tests run through vitest, from `.ts`, so the running module has no
    // build date to be behind. Saying "the server was built when someone last
    // saved this file" would be a different and false claim.
    expect(runningServerBuiltAt()).toBeNull();

    const now = Date.now();
    const here = laidOut({ webBuiltAt: now - 40 * MINUTE, serverOnDiskAt: now });

    expect(readBuildStamp(here).stale).toBe(false);
  });
});
