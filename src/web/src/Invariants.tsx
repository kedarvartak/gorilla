import { useCallback, useEffect, useState, type ReactElement } from 'react';

import { Panel } from './Panel.js';

import { api } from './api.js';

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
    const listed = await api.invariants<Invariant>(boardId);
    if (listed === null) {
      setError('Could not load the project rules.');
      return;
    }
    setRules(listed);

    // A shortlist that will not load must not hide the rules that did, and a
    // server older than this bundle answers with something else entirely - so
    // the shape is checked rather than trusted.
    const suggested = await api.invariantProposals<InvariantProposal>(boardId);
    setProposals((suggested ?? []).filter(isProposal));
  }, [boardId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function add(): Promise<void> {
    const text = statement.trim();
    if (text === '') return;

    setError(null);
    try {
      await api.addInvariant(boardId, text);
    } catch (cause) {
      // The duplicate refusal is worth showing rather than swallowing: it is
      // the drift this screen exists to prevent, arriving by a shorter route.
      setError((cause as Error).message);
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
    try {
      await api.addInvariant(boardId, statement);
    } catch (cause) {
      setError((cause as Error).message);
      return;
    }
    await load();
  }

  async function remove(id: string): Promise<void> {
    await api.removeInvariant(boardId, id);
    await load();
  }

  return (
    <Panel title="Project rules" onClose={onClose}>
      <header className="flex items-baseline gap-3 border-b border-line bg-panel px-4 py-2.5">
        <h2 className="text-[13px] font-semibold tracking-tight text-text">Project rules</h2>
        <span className="text-[11px] text-dim">Handed to every card this board dispatches</span>
        <button
          type="button"
          className="ml-auto rounded border border-line px-2 py-0.5 text-dim hover:text-text"
          onClick={onClose}
        >
          close
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
        <div className="mx-auto w-full max-w-3xl">
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
              <h3 className="mb-1.5 eyebrow">Already true of several cards ({proposals.length})</h3>
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
                    <div className="text-[11px] text-dim">
                      {/* Named, because the claim is falsifiable and the
                        operator may disagree with it. */}
                      {proposal.cards.map((card) => card.title).join(', ')}
                    </div>
                    <button
                      type="button"
                      className="mt-1 rounded border border-line px-2 py-0.5 text-[11px] text-dim hover:text-text"
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
                  <span className="text-[11px] text-dim">
                    learned on {rule.sourceCardId.slice(0, 8)}
                  </span>
                )}
                <button
                  type="button"
                  className="ml-auto rounded border border-line px-2 py-0.5 text-[11px] text-dim hover:text-warn"
                  onClick={() => void remove(rule.id)}
                >
                  remove
                </button>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </Panel>
  );
}
