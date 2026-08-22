import { useEffect, useState, type ReactElement } from 'react';

import { api } from './api.js';
import { Panel } from './Panel.js';

/**
 * Two attempts at the same work, beside each other (T61, T70).
 *
 * Reached by selecting two cards. The comparison route has existed since this
 * morning and could only be called with curl, which is the same as not
 * existing.
 */

interface Candidate {
  readonly cardId: string;
  readonly title: string;
  readonly status: string;
  readonly branch: string | null;
  readonly verify: string | null;
  readonly diff: {
    readonly files: readonly { path: string }[];
    readonly insertions: number;
    readonly deletions: number;
    readonly readable: boolean;
  };
  readonly tokens: number | null;
}

interface ComparisonBody {
  readonly candidates: readonly Candidate[];
  readonly shared: readonly string[];
  readonly note: string;
}

export function Compare({
  boardId,
  cardIds,
  onClose,
}: {
  boardId: string;
  cardIds: readonly string[];
  onClose: () => void;
}): ReactElement {
  const [body, setBody] = useState<ComparisonBody | null>(null);

  useEffect(() => {
    let cancelled = false;

    void api.compare<ComparisonBody>(boardId, cardIds).then((loaded) => {
      if (!cancelled) setBody(loaded);
    });

    return () => {
      cancelled = true;
    };
  }, [boardId, cardIds]);

  return (
    <Panel title="Two attempts compared" onClose={onClose}>
      <header className="flex items-baseline gap-3 border-b border-line bg-panel px-4 py-2.5">
        <h2 className="font-mono text-[13px] uppercase tracking-wider text-accent">Compared</h2>
        <span className="font-mono text-[11px] text-dim">{body?.note ?? ''}</span>
        <button
          type="button"
          className="ml-auto rounded border border-line px-2 py-0.5 text-dim hover:text-text"
          onClick={onClose}
        >
          close
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {body === null ? (
          <p className="text-dim">Reading both branches.</p>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3">
              {body.candidates.map((candidate) => (
                <section key={candidate.cardId} className="rounded border border-line bg-panel p-3">
                  <h3 className="mb-1 text-text">{candidate.title}</h3>
                  <dl className="grid grid-cols-[auto_1fr] gap-x-3 font-mono text-[11px]">
                    <dt className="text-dim">verify</dt>
                    <dd
                      className={
                        candidate.verify === 'passed'
                          ? 'text-ok'
                          : candidate.verify === null
                            ? 'text-dim'
                            : 'text-warn'
                      }
                    >
                      {/* Never blank. A candidate whose verify has not run is
                          not a candidate that passed. */}
                      {candidate.verify ?? 'not run'}
                    </dd>

                    <dt className="text-dim">changed</dt>
                    <dd className="text-text">
                      {candidate.diff.readable
                        ? `${String(candidate.diff.files.length)} file(s), +${String(candidate.diff.insertions)} −${String(candidate.diff.deletions)}`
                        : 'branch unreadable'}
                    </dd>

                    <dt className="text-dim">tokens</dt>
                    <dd className="text-text">
                      {/* Unrecorded, not free. A candidate that looked free
                          beside one that cost forty thousand would win an
                          argument it did not earn. */}
                      {candidate.tokens === null
                        ? 'not recorded'
                        : `${String(Math.round(candidate.tokens / 1000))}k`}
                    </dd>
                  </dl>
                </section>
              ))}
            </div>

            {body.shared.length === 0 ? null : (
              <div className="mt-4">
                <h3 className="mb-1 font-mono text-[11px] uppercase tracking-wider text-dim">
                  Touched by both
                </h3>
                {/* Where two alternatives disagree, which is the first thing
                    to read and the reason to open this at all. */}
                <ul className="flex flex-col gap-0.5 font-mono text-[11px] text-dim">
                  {body.shared.map((path) => (
                    <li key={path}>{path}</li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
      </div>
    </Panel>
  );
}
