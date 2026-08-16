import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Broadcaster } from '../src/server/stream/broadcaster.js';
import { startServer, type RunningServer } from '../src/server/start.js';

let dir: string;
let server: RunningServer;

const SESSION = 'abcdabcd-1111-4222-8333-444444444444';
const CWD = '/home/example/project';

const payloadFor = (
  event: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> => ({
  session_id: SESSION,
  hook_event_name: event,
  cwd: CWD,
  ...extra,
});

/**
 * Posts hook events over real HTTP. Deliberately not using T5's replay
 * harness: T6 should not depend on it, so the stream can be verified on its
 * own.
 */
async function post(
  url: string,
  events: readonly { event: string; payload: Record<string, unknown> }[],
): Promise<number> {
  let sent = 0;
  for (const entry of events) {
    const response = await fetch(`${url}/hooks/${entry.event}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(entry.payload),
    });
    await response.arrayBuffer();
    if (response.ok) sent += 1;
  }
  return sent;
}

/** Reads SSE frames from a live response until `wanted` hook events arrive. */
async function collect(
  url: string,
  wanted: number,
  headers: Record<string, string> = {},
): Promise<{ events: Record<string, unknown>[]; sawGap: boolean; controller: AbortController }> {
  const controller = new AbortController();
  const response = await fetch(url, { headers, signal: controller.signal });
  const reader = response.body?.getReader();
  if (reader === undefined) throw new Error('no stream body');

  const decoder = new TextDecoder();
  const events: Record<string, unknown>[] = [];
  let sawGap = false;
  let buffer = '';

  const deadline = Date.now() + 5_000;

  while (events.length < wanted && Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    let split = buffer.indexOf('\n\n');
    while (split !== -1) {
      const frame = buffer.slice(0, split);
      buffer = buffer.slice(split + 2);
      split = buffer.indexOf('\n\n');

      if (frame.includes('event: gap')) sawGap = true;

      const dataLine = frame.split('\n').find((line) => line.startsWith('data: '));
      if (dataLine !== undefined && frame.includes('event: hook')) {
        events.push(JSON.parse(dataLine.slice('data: '.length)) as Record<string, unknown>);
      }
    }
  }

  return { events, sawGap, controller };
}

describe('Broadcaster', () => {
  it('assigns monotonic ids and fans out to subscribers', () => {
    const broadcaster = new Broadcaster();
    const seen: number[] = [];
    broadcaster.subscribe((entry) => seen.push(entry.id));

    broadcaster.publish('hook', { a: 1 });
    broadcaster.publish('hook', { a: 2 });

    expect(seen).toEqual([1, 2]);
  });

  it('keeps publishing when a subscriber throws', () => {
    const broadcaster = new Broadcaster();
    const seen: number[] = [];

    broadcaster.subscribe(() => {
      throw new Error('a browser tab went away mid-write');
    });
    broadcaster.subscribe((entry) => seen.push(entry.id));

    expect(() => broadcaster.publish('hook', {})).not.toThrow();
    expect(seen).toEqual([1]);
  });

  it('stops delivering after unsubscribe', () => {
    const broadcaster = new Broadcaster();
    const seen: number[] = [];
    const unsubscribe = broadcaster.subscribe((entry) => seen.push(entry.id));

    broadcaster.publish('hook', {});
    unsubscribe();
    broadcaster.publish('hook', {});

    expect(seen).toEqual([1]);
    expect(broadcaster.subscriberCount).toBe(0);
  });

  it('replays only what a client missed', () => {
    const broadcaster = new Broadcaster();
    for (let i = 0; i < 5; i += 1) broadcaster.publish('hook', { i });

    expect(broadcaster.since(3).map((e) => e.id)).toEqual([4, 5]);
    expect(broadcaster.since(0)).toHaveLength(5);
    expect(broadcaster.since(5)).toHaveLength(0);
  });

  it('bounds the replay buffer and reports an unfillable gap', () => {
    const broadcaster = new Broadcaster(3);
    for (let i = 0; i < 10; i += 1) broadcaster.publish('hook', { i });

    expect(broadcaster.since(0)).toHaveLength(3);
    // Client last saw event 2, but the buffer now starts at 8.
    expect(broadcaster.hasGapBefore(2)).toBe(true);
    expect(broadcaster.hasGapBefore(9)).toBe(false);
    // A first-time connection is not a gap.
    expect(broadcaster.hasGapBefore(0)).toBe(false);
  });
});

describe('GET /stream', () => {
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'gorilla-stream-'));
    server = await startServer({ port: 4471, dbPath: join(dir, 'stream.db'), logger: false });
  });

  afterEach(async () => {
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it('delivers ingested events in order in real time', async () => {
    const pending = collect(`${server.url}/stream`, 3);
    // Let the subscription attach before publishing.
    await new Promise((resolve) => setTimeout(resolve, 100));

    await post(server.url, [
      { event: 'SessionStart', payload: payloadFor('SessionStart') },
      { event: 'PostToolUse', payload: payloadFor('PostToolUse', { tool_name: 'Edit' }) },
      { event: 'Stop', payload: payloadFor('Stop') },
    ]);

    const { events, controller } = await pending;
    controller.abort();

    expect(events.map((e) => e['event'])).toEqual(['SessionStart', 'PostToolUse', 'Stop']);
    expect(events[1]?.['toolName']).toBe('Edit');
    expect(events.map((e) => e['id'])).toEqual([1, 2, 3]);
  });

  it('replays missed events to a client that reconnects', async () => {
    // A client that never connected, then arrives having "seen" event 1.
    await post(server.url, [
      { event: 'SessionStart', payload: payloadFor('SessionStart') },
      { event: 'Stop', payload: payloadFor('Stop') },
      { event: 'SessionEnd', payload: payloadFor('SessionEnd') },
    ]);

    const { events, controller } = await collect(`${server.url}/stream`, 2, {
      'last-event-id': '1',
    });
    controller.abort();

    expect(events.map((e) => e['event'])).toEqual(['Stop', 'SessionEnd']);
  });

  it('sends nothing but stays open for a client that is up to date', async () => {
    await post(server.url, [{ event: 'Stop', payload: payloadFor('Stop') }]);

    const controller = new AbortController();
    const response = await fetch(`${server.url}/stream`, {
      headers: { 'last-event-id': '1' },
      signal: controller.signal,
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    controller.abort();
  });

  it('does not let a disconnected client leak a subscription', async () => {
    const controller = new AbortController();
    await fetch(`${server.url}/stream`, { signal: controller.signal });
    controller.abort();

    await new Promise((resolve) => setTimeout(resolve, 200));

    // Publishing after the client is gone must not throw or hang.
    const sent = await post(server.url, [{ event: 'Stop', payload: payloadFor('Stop') }]);
    expect(sent).toBe(1);
  });
});

describe('GET /', () => {
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'gorilla-web-'));
    server = await startServer({ port: 4472, dbPath: join(dir, 'web.db'), logger: false });
  });

  afterEach(async () => {
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it('serves the built board interface', async () => {
    const response = await fetch(server.url);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(body).toContain('Gorilla');
    expect(body).toContain('/assets/');
  });

  it('loads no external origin, so it works offline', async () => {
    const body = await (await fetch(server.url)).text();
    // Everything is served from this process; nothing reaches the network.
    expect(body).not.toMatch(/https?:\/\/(?!127\.0\.0\.1)/);
  });

  it('refuses to serve files outside the asset directory', async () => {
    const response = await fetch(`${server.url}/assets/..%2f..%2f..%2fpackage.json`);
    expect([403, 404]).toContain(response.status);
  });
});
