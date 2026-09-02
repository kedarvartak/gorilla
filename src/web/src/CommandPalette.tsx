import { useEffect, useRef, useState, type ReactElement } from 'react';
import type { Card } from './api.js';
import { MagnifyingGlass, Lightning, Plus } from '@phosphor-icons/react';

interface CommandItem {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly category: 'card' | 'action' | 'view';
  readonly icon?: ReactElement;
  readonly action: () => void;
}

interface CommandPaletteProps {
  readonly cards: readonly Card[];
  readonly onSelectCard: (card: Card) => void;
  readonly onCreateCard: () => void;
  readonly onResync: () => void;
}

export function CommandPalette({
  cards,
  onSelectCard,
  onCreateCard,
  onResync,
}: CommandPaletteProps): ReactElement {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const cardItems: CommandItem[] = cards
    .filter((c) => c.title.toLowerCase().includes(query.toLowerCase()))
    .slice(0, 8)
    .map((card) => ({
      id: card.id,
      label: card.title,
      description: card.status,
      category: 'card' as const,
      action: () => {
        onSelectCard(card);
        setOpen(false);
      },
    }));

  const actionItems: CommandItem[] = [
    {
      id: 'create',
      label: 'Create card',
      description: 'Add a new card to the board',
      category: 'action',
      icon: <Plus size={16} />,
      action: () => {
        onCreateCard();
        setOpen(false);
      },
    },
    {
      id: 'resync',
      label: 'Resync board',
      description: 'Check for completed work',
      category: 'action',
      icon: <Lightning size={16} />,
      action: () => {
        onResync();
        setOpen(false);
      },
    },
  ];

  const items = [
    ...cardItems,
    ...(query.length === 0 ? actionItems : []),
  ];

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setOpen((o) => !o);
        setQuery('');
        setSelected(0);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  useEffect(() => {
    if (open) {
      inputRef.current?.focus();
    }
  }, [open]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!open) return;

      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          setSelected((s) => (s + 1) % items.length);
          break;
        case 'ArrowUp':
          e.preventDefault();
          setSelected((s) => (s === 0 ? items.length - 1 : s - 1));
          break;
        case 'Enter':
          e.preventDefault();
          items[selected]?.action();
          break;
        case 'Escape':
          e.preventDefault();
          setOpen(false);
          break;
      }
    };

    if (open) {
      window.addEventListener('keydown', handleKeyDown);
    }
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open, selected, items]);

  if (!open) {
    return <div />;
  }

  return (
    <>
      <div
        className="fixed inset-0 z-40 bg-black/20"
        onClick={() => setOpen(false)}
        role="presentation"
      />
      <div className="fixed inset-x-0 top-0 z-50 flex items-start justify-center pt-[15vh]">
        <div className="w-full max-w-xl rounded-lg border border-line bg-surface shadow-lg">
          <div className="flex items-center gap-3 border-b border-line px-4 py-3">
            <MagnifyingGlass size={18} className="text-faint" aria-hidden />
            <input
              ref={inputRef}
              type="text"
              placeholder="Search cards, or type to see actions..."
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setSelected(0);
              }}
              className="min-w-0 flex-1 border-0 bg-transparent py-0 text-ink outline-none placeholder:text-faint"
            />
            <div className="text-xs text-faint">ESC</div>
          </div>

          {items.length === 0 ? (
            <div className="px-4 py-8 text-center text-dim">
              {query.length > 0 ? 'No results found' : 'No cards to show'}
            </div>
          ) : (
            <ul className="max-h-96 overflow-y-auto">
              {items.map((item, i) => (
                <li key={item.id}>
                  <button
                    type="button"
                    className={`w-full px-4 py-2.5 text-left transition-colors ${
                      i === selected ? 'bg-brand-tint' : 'hover:bg-well'
                    }`}
                    onClick={() => item.action()}
                    onMouseEnter={() => setSelected(i)}
                  >
                    <div className="flex items-center gap-3">
                      {item.icon && <span className="text-faint">{item.icon}</span>}
                      <div className="min-w-0 flex-1">
                        <div className="text-ink">{item.label}</div>
                        {item.description && (
                          <div className="text-xs text-faint">{item.description}</div>
                        )}
                      </div>
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}

          <div className="border-t border-line px-4 py-2 text-right text-xs text-faint">
            <kbd className="rounded border border-line px-1.5 py-0.5">↑↓</kbd>{' '}
            <kbd className="rounded border border-line px-1.5 py-0.5">Enter</kbd>
          </div>
        </div>
      </div>
    </>
  );
}
