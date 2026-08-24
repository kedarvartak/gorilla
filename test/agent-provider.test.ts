import { describe, expect, it } from 'vitest';

import { buildCodexArgs } from '../src/server/launcher/args.js';
import { isAgentProvider } from '../src/server/agents/providers.js';

describe('agent providers', () => {
  it('recognises only the dispatch providers Gorilla supports', () => {
    expect(isAgentProvider('claude')).toBe(true);
    expect(isAgentProvider('codex')).toBe(true);
    expect(isAgentProvider('gemini')).toBe(false);
  });

  it('builds a non-interactive Codex command with the card context', () => {
    expect(
      buildCodexArgs(
        {
          goalCondition: 'the test passes',
          guardrails: { scope: [], prohibit: [], allowTools: [], verify: null, maxTurns: null },
          agentModel: 'gpt-5.3-codex',
        },
        '# Card: Test\n\nKeep the change small.\n',
      ),
    ).toEqual([
      'exec',
      '--json',
      '--full-auto',
      '--model',
      'gpt-5.3-codex',
      '/goal the test passes\n\n# Card: Test\n\nKeep the change small.\n',
    ]);
  });
});
