/**
 * Server-Sent Events broadcaster (doc 06).
 *
 * SSE rather than WebSocket: the traffic is overwhelmingly server-to-client and
 * reconnection semantics come for free.
 *
 * Holds a bounded replay buffer so a client that reconnects with
 * `Last-Event-ID` receives what it missed. The buffer is deliberately small -
 * SQLite is the durable record, and this exists only to cover a dropped
 * connection, not to be a second event store.
 */

export interface StreamEvent {
  readonly id: number;
  readonly event: string;
  readonly data: unknown;
}

export type StreamSubscriber = (event: StreamEvent) => void;

export const DEFAULT_REPLAY_BUFFER = 500;

export class Broadcaster {
  #nextId = 1;
  readonly #buffer: StreamEvent[] = [];
  readonly #subscribers = new Set<StreamSubscriber>();

  constructor(private readonly bufferSize: number = DEFAULT_REPLAY_BUFFER) {}

  get subscriberCount(): number {
    return this.#subscribers.size;
  }

  publish(event: string, data: unknown): StreamEvent {
    const entry: StreamEvent = { id: this.#nextId, event, data };
    this.#nextId += 1;

    this.#buffer.push(entry);
    if (this.#buffer.length > this.bufferSize) this.#buffer.shift();

    for (const subscriber of this.#subscribers) {
      // One slow or throwing subscriber must not stop the others, and must
      // never propagate back into the ingest path that published this.
      try {
        subscriber(entry);
      } catch {
        continue;
      }
    }

    return entry;
  }

  /** Events after `lastEventId`, oldest first. Empty when nothing was missed. */
  since(lastEventId: number): StreamEvent[] {
    return this.#buffer.filter((entry) => entry.id > lastEventId);
  }

  /**
   * True when the client's position has fallen out of the buffer, so the gap
   * cannot be filled and the client should be told rather than silently given
   * an incomplete stream.
   */
  hasGapBefore(lastEventId: number): boolean {
    const oldest = this.#buffer[0];
    if (oldest === undefined) return false;
    return lastEventId > 0 && lastEventId < oldest.id - 1;
  }

  subscribe(subscriber: StreamSubscriber): () => void {
    this.#subscribers.add(subscriber);
    return () => {
      this.#subscribers.delete(subscriber);
    };
  }
}
