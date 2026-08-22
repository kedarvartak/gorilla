import { useEffect, useState, type ReactElement } from 'react';
import { X } from '@phosphor-icons/react';

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
      <header className="flex items-baseline gap-3 border-b border-line bg-surface px-4 py-2.5">
        <h2 className="text-[14.5px] font-semibold tracking-tight text-ink">Compared</h2>
        <span className="text-[12.5px] text-dim">{body?.note ?? ''}</span>
        <button
          type="button"
          aria-label="Close"
          className="ml-auto inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-dim transition-colors hover:bg-well hover:text-ink"
          onClick={onClose}
        >
          <X size={14} aria-hidden />
          Close
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
        <div className="mx-auto w-full max-w-5xl">
          {body === null ? (
            <p className="text-dim">Reading both branches.</p>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-3">
                {body.candidates.map((candidate) => (
                  <section
                    key={candidate.cardId}
                    className="rounded border border-line bg-surface p-3"
                  >
                    <h3 className="mb-1 text-ink">{candidate.title}</h3>
                    <dl className="grid grid-cols-[auto_1fr] gap-x-3 text-[12.5px]">
                      <dt className="text-dim">verify</dt>
                      <dd
                        className={
                          candidate.verify === 'passed'
                            ? 'text-ok'
                            : candidate.verify === null
                              ? 'text-dim'
                              : 'text-danger'
                        }
                      >
                        {/* Never blank. A candidate whose verify has not run is
                          not a candidate that passed. */}
                        {candidate.verify ?? 'not run'}
                      </dd>

                      <dt className="text-dim">changed</dt>
                      <dd className="text-ink">
                        {candidate.diff.readable
                          ? `${String(candidate.diff.files.length)} file(s), +${String(candidate.diff.insertions)} −${String(candidate.diff.deletions)}`
                          : 'branch unreadable'}
                      </dd>

                      <dt className="text-dim">tokens</dt>
                      <dd className="text-ink">
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
                  <h3 className="mb-1 eyebrow">Touched by both</h3>
                  {/* Where two alternatives disagree, which is the first thing
                    to read and the reason to open this at all. */}
                  <ul className="flex flex-col gap-0.5 text-[12.5px] text-dim">
                    {body.shared.map((path) => (
                      <li key={path}>{path}</li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </Panel>
  );
}
