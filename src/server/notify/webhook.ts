/**
 * Posting board events to something else (T45).
 *
 * `GORILLA_NOTIFY` runs a command, which is right for waking a person and
 * wrong for everything else: a status page, a Slack relay, or a second machine
 * wanting to know a card finished. Those want a request, not a shell.
 *
 * From the environment rather than the database, for the same reason the
 * notify command is: a delivery that only exists while a board is configured
 * through the interface is one that goes missing on the night it matters.
 */

export const WEBHOOK_ENV = 'GORILLA_WEBHOOK';

/**
 * Short. This runs on the settle path and on the halt path, and a webhook
 * pointing at something slow must not be able to hold up a queue.
 */
export const WEBHOOK_TIMEOUT_MS = 5_000;

export interface WebhookEvent {
  readonly event: 'card-finished' | 'card-blocked' | 'queue-halted';
  readonly boardId: string;
  readonly boardName: string;
  readonly cardId: string;
  readonly cardTitle: string;
  /** The halt reason, or the card's status. Never free-form prose. */
  readonly detail: string;
  readonly at: number;
}

/**
 * Only http and https, and only what the caller assembled.
 *
 * A url from the environment is trusted about as far as the operator who set
 * it, which is far - but `file:` and `data:` are not deliveries, and refusing
 * them here costs nothing and removes a class of surprise.
 */
export function isDeliverable(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * What is sent.
 *
 * Ids, a title, a status and a timestamp. Deliberately not the card body, the
 * diff, the ledger, or anything a run said: a webhook is a wire out of a
 * process that reads source code and transcripts, and the useful payload is
 * "something happened, come and look" rather than the thing itself (doc 11).
 */
export function payloadFor(event: WebhookEvent): string {
  return JSON.stringify(event);
}

export interface DeliverInput {
  readonly event: WebhookEvent;
  readonly url: string | undefined;
  readonly onError?: (error: Error) => void;
  /** Injected by tests. The global otherwise. */
  readonly send?: typeof fetch;
}

/**
 * Fire and forget. Returns whether a delivery was attempted, not whether it
 * arrived: waiting for a webhook to answer would make an unreachable endpoint
 * a reason the board stops working.
 */
export function deliverWebhook(input: DeliverInput): boolean {
  const url = (input.url ?? '').trim();
  if (url === '') return false;

  if (!isDeliverable(url)) {
    input.onError?.(new Error(`${WEBHOOK_ENV} is not an http or https url: ${url}`));
    return false;
  }

  const send = input.send ?? fetch;

  void send(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: payloadFor(input.event),
    signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
  }).then(
    () => undefined,
    // Reported, never thrown. A webhook is a courtesy; a board that died
    // because a status page was down would be a worse product than one with no
    // webhook at all.
    (error: Error) => input.onError?.(error),
  );

  return true;
}
