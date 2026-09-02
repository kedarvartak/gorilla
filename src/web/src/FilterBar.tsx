import { Select } from './Select.js';
import type { Card } from './api.js';

export interface FilterState {
  readonly status: Card['status'] | null;
  readonly priority: Card['priority'] | null;
  readonly agent: Card['agentProvider'] | null;
}

interface FilterBarProps {
  readonly filters: FilterState;
  readonly onFilterChange: (filters: FilterState) => void;
  readonly query: string;
  readonly onQueryChange: (query: string) => void;
  readonly activeCount: number;
}

export function FilterBar({
  filters,
  onFilterChange,
  query,
  onQueryChange,
  activeCount,
}: FilterBarProps) {
  const hasActive = query !== '' || filters.status || filters.priority || filters.agent;

  return (
    <div className="filter-bar">
      <input
        type="text"
        className="field"
        placeholder="Search cards..."
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
        style={{ flex: 1, minWidth: '200px' }}
      />

      <Select
        variant="bare"
        placeholder="All statuses"
        value={filters.status ?? ''}
        onChange={(value) =>
          onFilterChange({ ...filters, status: (value as Card['status']) || null })
        }
        options={[
          { value: '', label: 'All statuses' },
          { value: 'idle', label: 'Idle' },
          { value: 'queued', label: 'Queued' },
          { value: 'running', label: 'Running' },
          { value: 'awaiting-review', label: 'Awaiting Review' },
          { value: 'blocked', label: 'Blocked' },
          { value: 'done', label: 'Done' },
          { value: 'abandoned', label: 'Abandoned' },
        ]}
      />

      <Select
        variant="bare"
        placeholder="All priorities"
        value={filters.priority ?? ''}
        onChange={(value) =>
          onFilterChange({ ...filters, priority: (value as Card['priority']) || null })
        }
        options={[
          { value: '', label: 'All priorities' },
          { value: 'high', label: 'High' },
          { value: 'normal', label: 'Normal' },
          { value: 'low', label: 'Low' },
        ]}
      />

      <Select
        variant="bare"
        placeholder="All agents"
        value={filters.agent ?? ''}
        onChange={(value) =>
          onFilterChange({ ...filters, agent: (value as Card['agentProvider']) || null })
        }
        options={[
          { value: '', label: 'All agents' },
          { value: 'claude', label: 'Claude' },
          { value: 'codex', label: 'Codex' },
        ]}
      />

      {hasActive && (
        <button
          className="filter-clear"
          onClick={() => {
            onQueryChange('');
            onFilterChange({ status: null, priority: null, agent: null });
          }}
        >
          Clear
        </button>
      )}

      {activeCount > 0 && (
        <span className="filter-count" title="Cards matching filters">
          {activeCount}
        </span>
      )}
    </div>
  );
}
