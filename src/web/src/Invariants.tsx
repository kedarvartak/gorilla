import { useCallback, useEffect, useState, type ReactElement } from 'react';

/**
 * Rules that hold for the project rather than for one card (doc 12, output 2).
 *
 * A guardrail on a card says something about that card. A rule like "migrations
 * are additive" or "never edit the generated client" says something about the
 * project, and restating it on every card is how it drifts: five cards carrying
 * five slightly different versions of one rule is a rule nobody can rely on.
 *
 * So it is stated once, here, and the dispatcher hands it to every card it
 * launches - marked as a project rule, so the agent can tell a standing
 * constraint from this task's peculiarity.
 */

export interface Invariant {
  readonly id: string;
  readonly statement: string;
  readonly sourceCardId: string | null;
  readonly createdAt: number;
}

export interface InvariantProposal {
  readonly statement: string;
  readonly cards: readonly { id: string; title: string }[];
  readonly why: string;
}

function isProposal(value: unknown): value is InvariantProposal {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as InvariantProposal).statement === 'string' &&
    Array.isArray((value as InvariantProposal).cards)
  );
}

export function Invariants({
  boardId,
  onClose,
}: {
  boardId: string;
  onClose: () => void;
}): ReactElement {
  const [rules, setRules] = useState<readonly Invariant[] | null>(null);
  const [proposals, setProposals] = useState<readonly InvariantProposal[]>([]);
  const [statement, setStatement] = useState('');
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    try {
      const response = await fetch(`/api/boards/${boardId}/invariants`);
      if (!response.ok) throw new Error(`Could not load the rules: ${String(response.status)}`);
      setRules((await response.json()) as Invariant[]);

      // A shortlist that will not load must not hide the rules that did.
      const suggested = await fetch(`/api/boards/${boardId}/invariant-proposals`);
      if (suggested.ok) {
        const body: unknown = await suggested.json();
        // Shape-checked rather than trusted. A server older than this bundle
        // has no such route, and whatever answers instead must not be able to
        // break the panel that lists the rules.
        setProposals(Array.isArray(body) ? body.filter(isProposal) : []);
      }
    } catch (cause) {
      setError((cause as Error).message);
    }
  }, [boardId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function add(): Promise<void> {
    const text = statement.trim();
    if (text === '') return;

    setError(null);
    const response = await fetch(`/api/boards/${boardId}/invariants`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ statement: text }),
    });

    if (!response.ok) {
      // The duplicate refusal is worth showing rather than swallowing: it is
      // the drift this screen exists to prevent, arriving by a shorter route.
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      setError(body.error ?? `Could not add that rule: ${String(response.status)}`);
      return;
    }

    setStatement('');
    await load();
  }

  /**
   * Writing a proposal down is still the operator's act.
   *
   * An invariant reaches every future card, so one the board wrote by itself
   * would constrain work nobody agreed to constrain.
   */
  async function accept(statement: string): Promise<void> {
    setError(null);
    await fetch(`/api/boards/${boardId}/invariants`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ statement }),
    });
    await load();
  }

  async function remove(id: string): Promise<void> {
    await fetch(`/api/boards/${boardId}/invariants/${id}`, { method: 'DELETE' });
    await load();
  }

  return (
    <div className="absolute inset-0 z-10 flex flex-col bg-bg/95">
      <header className="flex items-baseline gap-3 border-b border-line bg-panel px-4 py-2.5">
        <h2 className="font-mono text-[13px] uppercase tracking-wider text-accent">
          Project rules
        </h2>
        <span className="font-mono text-[11px] text-dim">
          Handed to every card this board dispatches
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
        <div className="mb-3 flex gap-2">
          <input
            className="flex-1 rounded border border-line bg-panel-2 px-2 py-1 text-text placeholder:text-dim"
            placeholder="A rule that is true of every card on this board"
            aria-label="New project rule"
            value={statement}
            onChange={(changed) => setStatement(changed.target.value)}
            onKeyDown={(key) => {
              if (key.key === 'Enter') void add();
            }}
          />
          <button
            type="button"
            className="rounded border border-line bg-panel-2 px-2 py-1 text-text hover:border-dim"
            onClick={() => void add()}
          >
            Add
          </button>
        </div>

        {error !== null ? <p className="mb-3 text-warn">{error}</p> : null}

        {rules !== null && rules.length === 0 ? (
          // Said plainly. An empty list here is a legitimate state, not a
          // setup step the operator has failed to complete.
          <p className="text-dim">
            No project rules yet. Every card carries only its own guardrails.
          </p>
        ) : null}

        {proposals.length === 0 ? null : (
          <div className="mb-4">
            <h3 className="mb-1.5 font-mono text-[11px] uppercase tracking-wider text-dim">
              Already true of several cards ({proposals.length})
            </h3>
            {/* A rule written onto three cards is one project rule nobody has
                written down. Left that way it drifts: the fourth card gets a
                different wording and the fifth gets none at all. */}
            <ul className="flex flex-col gap-1.5">
              {proposals.map((proposal) => (
                <li
                  key={proposal.statement}
                  className="rounded border border-dashed border-line bg-panel px-3 py-2"
                >
                  <div className="text-text">{proposal.statement}</div>
                  <div className="font-mono text-[11px] text-dim">
                    {/* Named, because the claim is falsifiable and the
                        operator may disagree with it. */}
                    {proposal.cards.map((card) => card.title).join(', ')}
                  </div>
                  <button
                    type="button"
                    className="mt-1 rounded border border-line px-2 py-0.5 font-mono text-[11px] text-dim hover:text-text"
                    onClick={() => void accept(proposal.statement)}
                  >
                    make it a project rule
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        <ul className="flex flex-col gap-1.5">
          {(rules ?? []).map((rule) => (
            <li
              key={rule.id}
              className="flex items-baseline gap-3 rounded border border-line bg-panel px-3 py-2"
            >
              <span className="text-text">{rule.statement}</span>
              {rule.sourceCardId === null ? null : (
                // Where it came from, because a rule whose origin nobody knows
                // is a rule nobody dares remove.
                <span className="font-mono text-[11px] text-dim">
                  learned on {rule.sourceCardId.slice(0, 8)}
                </span>
              )}
              <button
                type="button"
                className="ml-auto rounded border border-line px-2 py-0.5 font-mono text-[11px] text-dim hover:text-warn"
                onClick={() => void remove(rule.id)}
              >
                remove
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
