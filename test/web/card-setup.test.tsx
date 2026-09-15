import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CardSetup } from '../../src/web/src/CardSetup.js';
import { makeCard, buttons } from './dom.js';

let container: HTMLDivElement;
let root: Root;
const rails = { scope: [], prohibit: [], allowTools: ['Read'], verify: null, maxTurns: 12 };
beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function edit(label: string, value: string): void {
  const field = container.querySelector<HTMLTextAreaElement>(`textarea[aria-label="${label}"]`);
  if (!field) throw new Error(`Missing ${label}`);
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(
      field,
      value,
    );
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

it('saves the exact draft before dispatch, preserving other guardrail settings', async () => {
  const order: string[] = [];
  const save = vi.fn(async () => {
    order.push('save');
  });
  const run = vi.fn(async () => {
    order.push('run');
  });
  act(() =>
    root.render(
      <CardSetup
        card={makeCard()}
        rails={rails}
        enforcement={[]}
        onSave={save}
        onRun={run}
        runDisabled={null}
      />,
    ),
  );
  edit('goal condition', 'The login tests pass');
  edit('prohibitions', 'Do not add dependencies, including test helpers\n.env');
  edit('verify command', 'npm test');
  await act(async () => {
    buttons(container, 'Save & run agent')[0]?.click();
  });
  expect(order).toEqual(['save', 'run']);
  expect(save).toHaveBeenCalledWith(
    expect.objectContaining({
      goalCondition: 'The login tests pass',
      guardrails: {
        ...rails,
        verify: 'npm test',
        prohibit: ['Do not add dependencies, including test helpers', '.env'],
      },
    }),
  );
});

it('keeps the draft and does not dispatch when saving fails', async () => {
  const run = vi.fn(async () => {});
  act(() =>
    root.render(
      <CardSetup
        card={makeCard()}
        rails={rails}
        enforcement={[]}
        onSave={async () => {
          throw new Error('Unable to save');
        }}
        onRun={run}
        runDisabled={null}
      />,
    ),
  );
  edit('goal condition', 'Keep my edited goal');
  await act(async () => {
    buttons(container, 'Save & run agent')[0]?.click();
  });
  expect(run).not.toHaveBeenCalled();
  expect(container.querySelector('[role="alert"]')?.textContent).toBe('Unable to save');
  expect(container.querySelector<HTMLTextAreaElement>('[aria-label="goal condition"]')?.value).toBe(
    'Keep my edited goal',
  );
});

it('explains an unmet dependency and disables dispatch', () => {
  act(() =>
    root.render(
      <CardSetup
        card={makeCard()}
        rails={rails}
        enforcement={[]}
        onSave={async () => {}}
        onRun={async () => {}}
        runDisabled="Waiting for: API endpoint"
      />,
    ),
  );
  expect(buttons(container, 'Save & run agent')[0]?.disabled).toBe(true);
  expect(container.textContent).toContain('Waiting for: API endpoint');
});
