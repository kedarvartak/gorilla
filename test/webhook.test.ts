import { describe, expect, it, vi } from 'vitest';

import {
  deliverWebhook,
  isDeliverable,
  payloadFor,
  WEBHOOK_TIMEOUT_MS,
  type WebhookEvent,
} from '../src/server/notify/webhook.js';

/**
 * Posting board events to something that is not a person (T45).
 *
 * `GORILLA_NOTIFY` runs a command, which is right for waking somebody up and
 * wrong for a status page, a relay, or a second machine.
 */

const EVENT: WebhookEvent = {
  event: 'queue-halted',
  boardId: 'board-1',
  boardName: 'the board',
  cardId: 'card-1',
  cardTitle: 'a card',
  detail: 'verify-failed',
  at: 1_700_000_000_000,
};

describe('what gets sent', () => {
  it('carries the ids, the title and the reason', () => {
    const parsed = JSON.parse(payloadFor(EVENT)) as Record<string, unknown>;

    expect(parsed['cardId']).toBe('card-1');
    expect(parsed['detail']).toBe('verify-failed');
  });

  it('carries nothing a run said', () => {
    const payload = payloadFor(EVENT);

    // A wire out of a process that reads source code and transcripts. The
    // useful payload is "something happened, come and look" (doc 11).
    expect(Object.keys(JSON.parse(payload) as object).sort()).toEqual([
      'at',
      'boardId',
      'boardName',
      'cardId',
      'cardTitle',
      'detail',
      'event',
    ]);
  });

  it('survives a card title that would break a shell', () => {
    // The notify path has to worry about this. This one does not, and the test
    // records that it is JSON rather than leaving it to be rediscovered.
    const payload = payloadFor({ ...EVENT, cardTitle: '"; rm -rf / #$(whoami)' });

    expect((JSON.parse(payload) as { cardTitle: string }).cardTitle).toBe('"; rm -rf / #$(whoami)');
  });
});

describe('where it will send', () => {
  it('accepts http and https', () => {
    expect(isDeliverable('http://localhost:9000/hook')).toBe(true);
    expect(isDeliverable('https://example.test/hook')).toBe(true);
  });

  it('refuses anything else', () => {
    // Not deliveries, and refusing them costs nothing.
    expect(isDeliverable('file:///etc/passwd')).toBe(false);
    expect(isDeliverable('data:text/plain,hello')).toBe(false);
    expect(isDeliverable('not a url')).toBe(false);
  });
});

describe('delivering', () => {
  it('posts the payload', () => {
    const send = vi.fn().mockResolvedValue(new Response('', { status: 200 }));

    expect(deliverWebhook({ event: EVENT, url: 'https://example.test/hook', send })).toBe(true);
    expect(send).toHaveBeenCalledOnce();

    const [, init] = send.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe('POST');
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('does nothing when no url is configured', () => {
    const send = vi.fn();

    expect(deliverWebhook({ event: EVENT, url: undefined, send })).toBe(false);
    expect(deliverWebhook({ event: EVENT, url: '   ', send })).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it('reports a bad url instead of attempting it', () => {
    const errors: Error[] = [];
    const send = vi.fn();

    deliverWebhook({
      event: EVENT,
      url: 'file:///etc/passwd',
      send,
      onError: (error) => errors.push(error),
    });

    expect(send).not.toHaveBeenCalled();
    expect(errors[0]?.message).toContain('http or https');
  });

  it('does not throw when the endpoint is down', async () => {
    const errors: Error[] = [];
    const send = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    expect(() =>
      deliverWebhook({
        event: EVENT,
        url: 'https://example.test/hook',
        send,
        onError: (error) => errors.push(error),
      }),
    ).not.toThrow();

    // A board that died because a status page was down would be a worse
    // product than one with no webhook at all.
    await vi.waitFor(() => expect(errors).toHaveLength(1));
  });

  it('gives up quickly enough not to hold a queue', () => {
    expect(WEBHOOK_TIMEOUT_MS).toBeLessThanOrEqual(5_000);
  });
});
