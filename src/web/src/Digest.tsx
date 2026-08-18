import { useEffect, useState, type ReactElement } from 'react';

/**
 * The morning digest (doc 18, U6).
 *
 * The board answers "what is the state of everything", and a card answers "what
 * happened here". Neither answers the question this product exists for, which is
 * asked once a day from a standing start: *what happened while I was asleep, and
 * what needs me first*.
 *
 * The ordering is the whole feature. The server ranks by significance - a failed
 * verify outranks a blocked card, which outranks unseen entries - so this screen
 * never sorts by time. A list in time order makes the operator read all of it to
 * find the one thing that matters, which is the volume problem again.
 */

export interface DigestEntry {
  readonly cardId: string;
  readonly title: string;
  readonly status: string;
  readonly unseen: number;
  readonly headline: string;
  readonly verify: 'passed' | 'failed' | 'errored' | 'skipped' | null;
}

/** Why this card is where it is in the list, in the operator's terms. */
function reasonFor(entry: DigestEntry): { text: string; tone: string } | null {
  if (entry.verify === 'failed' || entry.verify === 'errored') {
    return { text: 'the board ran its verify and it did not pass', tone: 'text-warn' };
  }
  if (entry.status === 'blocked') {
    return { text: 'stopped and waiting for you', tone: 'text-warn' };
  }
  if (entry.unseen > 0) {
    return {
      text: `${String(entry.unseen)} entr${entry.unseen === 1 ? 'y' : 'ies'} you have not read`,
      tone: 'text-accent',
    };
  }
  return null;
}

export function Digest({
  boardId,
  onOpen,
  onClose,
}: {
  boardId: string;
  onOpen: (cardId: string) => void;
  onClose: () => void;
}): ReactElement {
  const [entries, setEntries] = useState<readonly DigestEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const response = await fetch(`/api/boards/${boardId}/digest`);
        if (!response.ok) throw new Error(`Could not load the digest: ${response.status}`);
        if (!cancelled) setEntries((await response.json()) as DigestEntry[]);
      } catch (cause) {
        if (!cancelled) setError((cause as Error).message);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [boardId]);

  return (
    <div className="absolute inset-0 z-10 flex flex-col bg-bg/95">
      <header className="flex items-baseline gap-3 border-b border-line bg-panel px-4 py-2.5">
        <h2 className="font-mono text-[13px] uppercase tracking-wider text-accent">
          While you were away
        </h2>
        <span className="font-mono text-[11px] text-dim">
          {entries === null ? '' : `${String(entries.length)} active card(s), most urgent first`}
        </span>
        <button
          type="button"
          className="ml-auto rounded border border-line px-2 py-0.5 text-dim hover:text-text"
          onClick={onClose}
        >
          close
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {error !== null ? <p className="text-warn">{error}</p> : null}

        {entries === null && error === null ? <p className="text-dim">Loading…</p> : null}

        {entries !== null && entries.length === 0 ? (
          // The good morning. Said in one line so it costs nothing to read.
          <p className="text-dim">
            Nothing is active. No card is running, blocked, or waiting to be reviewed.
          </p>
        ) : null}

        <ul className="flex flex-col gap-2">
          {(entries ?? []).map((entry) => {
            const reason = reasonFor(entry);
            return (
              <li key={entry.cardId}>
                <button
                  type="button"
                  className="w-full rounded border border-line bg-panel px-3 py-2 text-left hover:border-dim"
                  onClick={() => onOpen(entry.cardId)}
                >
                  <div className="flex items-baseline gap-3">
                    <span className="text-text">{entry.title}</span>
                    <span className="font-mono text-[11px] text-dim">{entry.status}</span>
                    {reason === null ? null : (
                      <span className={`ml-auto font-mono text-[11px] ${reason.tone}`}>
                        {reason.text}
                      </span>
                    )}
                  </div>
                  {/* The brief's own headline, so this screen and the card agree
                      rather than each summarising separately. */}
                  <div className="mt-0.5 font-mono text-[11px] text-dim">{entry.headline}</div>
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
