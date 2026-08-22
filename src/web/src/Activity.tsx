import { useEffect, useRef, useState, type ReactElement } from 'react';

/**
 * The live feed (doc 09).
 *
 * Every other surface here answers a question about the past. This one answers
 * "is anything happening", which sounds like a lesser question and is not: an
 * operator who cannot see work in progress has no way to tell a busy agent from
 * a wedged one, and will either sit watching a static board or stop trusting it.
 *
 * The terminal gives that for free and the board threw it away, because a hook
 * event is written, stored, and then only ever read back as history.
 *
 * Deliberately not a log. Lines are rendered per card, newest first, with the
 * tool and its target, and mechanical noise is dropped rather than shown - the
 * point is a sense of motion and attribution, not completeness. The timeline is
 * where completeness lives.
 */

export interface HookEvent {
  readonly id: number;
  readonly runId: string;
  readonly cardId: string | null;
  readonly event: string;
  readonly receivedAt: number;
  readonly toolName: string | null;
  readonly target: string | null;
}

/** Kept short: this is a window on the present, not a record. */
const MAX_EVENTS = 200;

/**
 * Events that say something changed. `PreToolUse` is dropped because it always
 * arrives paired with an outcome, and showing both doubles the feed to say the
 * same thing twice.
 */
const INTERESTING: ReadonlySet<string> = new Set([
  'PostToolUse',
  'PostToolUseFailure',
  'UserPromptSubmit',
  'Stop',
  'SessionStart',
  'SessionEnd',
  'PreCompact',
  'Notification',
  'PermissionRequest',
]);

function describe(entry: HookEvent): string {
  if (entry.toolName !== null) {
    const target = entry.target === null ? '' : ` ${entry.target.slice(0, 80)}`;
    return `${entry.toolName}${target}`;
  }

  switch (entry.event) {
    case 'UserPromptSubmit':
      return 'received its instructions';
    case 'SessionStart':
      return 'session started';
    case 'SessionEnd':
      return 'session ended';
    case 'Stop':
      return 'finished a turn';
    case 'PreCompact':
      return 'context is being compacted';
    case 'Notification':
      return 'raised a notification';
    case 'PermissionRequest':
      return 'asked for a permission';
    default:
      return entry.event;
  }
}

function tone(entry: HookEvent): string {
  if (entry.event === 'PostToolUseFailure') return 'text-danger';
  if (entry.event === 'PreCompact' || entry.event === 'Notification') return 'text-brand';
  if (entry.event === 'SessionEnd' || entry.event === 'Stop') return 'text-dim';
  return 'text-ink';
}

function clock(at: number): string {
  return new Date(at).toLocaleTimeString();
}

export function Activity({
  titleFor,
  live,
}: {
  /** Card titles, so a line reads as work rather than as an id. */
  titleFor: (cardId: string | null) => string;
  live: boolean;
}): ReactElement {
  const [events, setEvents] = useState<readonly HookEvent[]>([]);
  const seen = useRef(new Set<string>());

  useEffect(() => {
    const source = new EventSource('/stream');

    const onHook = (message: MessageEvent<string>): void => {
      try {
        const entry = JSON.parse(message.data) as HookEvent;
        if (!INTERESTING.has(entry.event)) return;

        // The stream resends on reconnect, and a feed that repeats itself looks
        // like activity that is not happening.
        const key = `${entry.runId}:${String(entry.id)}`;
        if (seen.current.has(key)) return;
        seen.current.add(key);

        setEvents((current) => [entry, ...current].slice(0, MAX_EVENTS));
      } catch {
        /* a malformed frame is not worth breaking the feed for */
      }
    };

    source.addEventListener('hook', onHook as EventListener);
    return () => source.close();
  }, []);

  return (
    <section className="flex min-h-0 flex-col border-t border-line bg-well">
      <header className="flex items-baseline gap-2 border-b border-line px-4 py-1.5">
        <h3 className="eyebrow">Activity</h3>
        <span className={`text-[12.5px] ${live ? 'text-ok' : 'text-danger'}`}>
          {live ? 'live' : 'not connected'}
        </span>
        {events.length === 0 ? null : (
          <span className="text-[12.5px] text-dim">{events.length} recent</span>
        )}
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-1.5">
        {events.length === 0 ? (
          // Says which of the two silences this is, because "nothing running"
          // and "not receiving" look identical.
          <p className="text-[12.5px] text-dim">
            {live
              ? 'Nothing has happened since this view opened. Dispatch a card to see it work.'
              : 'Not receiving events. The board may have stopped.'}
          </p>
        ) : (
          <ul className="flex flex-col">
            {events.map((entry) => (
              <li
                key={`${entry.runId}:${String(entry.id)}`}
                className="flex gap-3 text-[12.5px] leading-relaxed"
              >
                <span className="shrink-0 text-dim">{clock(entry.receivedAt)}</span>
                <span className="w-40 shrink-0 truncate text-info" title={titleFor(entry.cardId)}>
                  {titleFor(entry.cardId)}
                </span>
                <span className={`truncate ${tone(entry)}`}>{describe(entry)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
