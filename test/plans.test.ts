import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '../src/server/app.js';
import { openDatabase, type DatabaseHandle } from '../src/server/db/client.js';
import { planCommand } from '../src/hooks/plan-command.js';

let dir: string;
let database: DatabaseHandle;
let app: FastifyInstance;
let boardId: string;

interface PlanResponse {
  planId: string;
  created: { id: string; title: string; guardrails: string }[];
  warnings: { title: string; warnings: { code: string; severity: string }[] }[];
  unresolvedDependencies: { title: string; missing: string }[];
  next: string;
}

async function postPlan(cards: unknown[], extra: Record<string, unknown> = {}) {
  const response = await app.inject({
    method: 'POST',
    url: `/api/boards/${boardId}/plans`,
    payload: { cards, ...extra },
  });
  return { status: response.statusCode, body: response.json() as PlanResponse };
}

const GOOD_CONDITION = '`npm test` exits 0, or stop after 20 turns';

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'gorilla-plans-'));
  database = openDatabase({ path: join(dir, 'plans.db') });
  app = buildApp({ database, logger: false });
  await app.ready();

  const board = await app.inject({
    method: 'POST',
    url: '/api/boards',
    payload: { name: 'test', cwd: dir },
  });
  boardId = (board.json() as { id: string }).id;
});

afterEach(async () => {
  await app.close();
  database.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('plan intake', () => {
  it('creates every card in one call', async () => {
    const result = await postPlan([
      { title: 'First', goalCondition: GOOD_CONDITION },
      { title: 'Second', goalCondition: GOOD_CONDITION },
      { title: 'Third', goalCondition: GOOD_CONDITION },
    ]);

    expect(result.status).toBe(201);
    expect(result.body.created).toHaveLength(3);
    expect(result.body.warnings).toHaveLength(0);
  });

  it('lands everything unstarted in the first column', async () => {
    await postPlan([{ title: 'Confident', goalCondition: GOOD_CONDITION }]);

    const columns = await app.inject({ method: 'GET', url: `/api/boards/${boardId}/columns` });
    const first = (columns.json() as { id: string; name: string }[])[0];

    const cards = await app.inject({ method: 'GET', url: `/api/boards/${boardId}/cards` });
    const card = (cards.json() as { columnId: string; status: string }[])[0];

    // A planning conversation feels complete at the time and often is not, so
    // promotion stays an operator action.
    expect(card?.columnId).toBe(first?.id);
    expect(card?.status).toBe('idle');
  });

  it('records the conversation that produced it', async () => {
    const result = await postPlan([{ title: 'x', goalCondition: GOOD_CONDITION }], {
      sourceSessionId: 'sess-123',
      prompt: 'break down the ingest work',
    });

    const plan = await app.inject({ method: 'GET', url: `/api/plans/${result.body.planId}` });
    const body = plan.json() as { plan: { sourceSessionId: string; prompt: string } };

    expect(body.plan.sourceSessionId).toBe('sess-123');
    expect(body.plan.prompt).toContain('ingest');
  });

  it('resolves dependencies by title within the batch', async () => {
    const result = await postPlan([
      { title: 'Schema', goalCondition: GOOD_CONDITION },
      { title: 'API', goalCondition: GOOD_CONDITION, dependsOn: ['Schema'] },
    ]);

    const api = result.body.created.find((card) => card.title === 'API');
    const detail = await app.inject({ method: 'GET', url: `/api/cards/${api?.id}` });
    const body = detail.json() as { dependsOn: string[]; blockers: unknown[] };

    expect(body.dependsOn).toHaveLength(1);
    expect(body.blockers).toHaveLength(1);
  });

  it('reports an unknown dependency rather than discarding the plan', async () => {
    const result = await postPlan([
      { title: 'API', goalCondition: GOOD_CONDITION, dependsOn: ['Typo'] },
    ]);

    // A mistyped title should not throw away otherwise good work.
    expect(result.status).toBe(201);
    expect(result.body.created).toHaveLength(1);
    expect(result.body.unresolvedDependencies).toEqual([{ title: 'API', missing: 'Typo' }]);
  });
});

describe('validation warnings', () => {
  it('warns per card, naming which card', async () => {
    const result = await postPlan([
      { title: 'Fine', goalCondition: GOOD_CONDITION },
      { title: 'Vague', goalCondition: 'make the code cleaner' },
    ]);

    expect(result.body.warnings).toHaveLength(1);
    expect(result.body.warnings[0]?.title).toBe('Vague');

    const codes = result.body.warnings[0]?.warnings.map((w) => w.code) ?? [];
    expect(codes).toContain('no-verifiable-check');
    expect(codes).toContain('asks-for-judgement');
  });

  /**
   * Changed deliberately, 27 August 2026. This used to land the card and
   * return the error as a warning, on the reasoning that the operator might
   * fill the condition in on the board. They do not: a card with no goal
   * condition is excluded from dispatch, so it sits there looking like queued
   * work that the queue cannot take, and the only signal was a warning
   * returned to an agent that had just finished planning.
   */
  it('refuses a card with no goal condition rather than landing one that cannot run', async () => {
    const result = await postPlan([{ title: 'No condition' }]);

    expect(result.status).toBe(400);
    expect(result.body.error).toContain('goal condition');
  });

  it('refuses the whole plan, so a file does not half-land', async () => {
    const result = await postPlan([
      { title: 'Fine', goalCondition: GOOD_CONDITION },
      { title: 'No condition' },
    ]);

    expect(result.status).toBe(400);
    // Named, because the fix is per card and a count would leave the agent
    // diffing its own output against the board.
    expect(result.body.error).toContain('No condition');
  });

  it('still lands a card whose condition is merely weak', async () => {
    const result = await postPlan([{ title: 'Vague', goalCondition: 'make it nice' }]);

    expect(result.status).toBe(201);
    expect(result.body.created).toHaveLength(1);
  });

  it('tells the agent to fix warnings in the conversation', async () => {
    const withWarnings = await postPlan([{ title: 'Vague', goalCondition: 'make it nice' }]);
    expect(withWarnings.body.next).toContain('while the context');

    const clean = await postPlan([{ title: 'Fine', goalCondition: GOOD_CONDITION }]);
    expect(clean.body.next).toContain('Promote');
  });

  it('summarises each card’s guardrails in the response', async () => {
    const result = await postPlan([
      {
        title: 'Guarded',
        goalCondition: GOOD_CONDITION,
        guardrails: { prohibit: ['src/db/schema.ts'], verify: 'npm test' },
      },
    ]);

    expect(result.body.created[0]?.guardrails).toContain('prohibition');
    expect(result.body.created[0]?.guardrails).toContain('verify');
  });
});

describe('rejection', () => {
  it('refuses an empty plan', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/api/boards/${boardId}/plans`,
      payload: { cards: [] },
    });

    expect(response.statusCode).toBe(400);
  });

  it('refuses a card with no title, without half-landing the plan', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/api/boards/${boardId}/plans`,
      payload: { cards: [{ title: 'Fine', goalCondition: GOOD_CONDITION }, { body: 'no title' }] },
    });

    expect(response.statusCode).toBe(400);

    // One transaction: a partial plan would leave the operator reconciling
    // against a conversation that has already moved on.
    const cards = await app.inject({ method: 'GET', url: `/api/boards/${boardId}/cards` });
    expect(cards.json()).toHaveLength(0);
  });

  it('reports an unknown plan as 404', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/plans/nope' });
    expect(response.statusCode).toBe(404);
  });
});

describe('the /gorilla:plan command', () => {
  const command = planCommand('http://127.0.0.1:4300');

  it('teaches the evaluator’s tool-blindness, which is the common trap', () => {
    expect(command).toContain('does not run commands');
    expect(command).toContain('measurable end state');
    expect(command).toContain('4,000');
  });

  it('teaches the guardrail enforcement distinction', () => {
    expect(command).toContain('deny rules Claude Code enforces');
    expect(command).toContain('advisory');
  });

  it('tells the agent to report warnings back rather than leaving them', () => {
    expect(command).toContain('Read them out');
    expect(command).toContain('while the context');
  });

  it('tells the agent not to dispatch', () => {
    expect(command).toContain("operator's decision");
  });

  it('points at the right endpoint', () => {
    expect(planCommand('http://127.0.0.1:4300', 'board-9')).toContain('/api/boards/board-9/plans');
  });
});

describe('priority in a plan', () => {
  it('carries a per-card priority through to the board', async () => {
    const posted = await postPlan([
      { title: 'Urgent one', goalCondition: GOOD_CONDITION, priority: 'high' },
      { title: 'Ordinary one', goalCondition: GOOD_CONDITION },
    ]);

    expect(posted.status).toBe(201);

    const listed = await app.inject({ method: 'GET', url: `/api/boards/${boardId}/cards` });
    const byTitle = new Map(
      (listed.json() as { title: string; priority: string }[]).map((card) => [
        card.title,
        card.priority,
      ]),
    );

    expect(byTitle.get('Urgent one')).toBe('high');
    expect(byTitle.get('Ordinary one')).toBe('normal');
  });

  it('refuses an unknown priority rather than quietly defaulting it', async () => {
    // A planning agent that asked for a priority and silently got `normal`
    // would leave the operator believing the batch was ordered when it was not.
    const refused = await postPlan([
      { title: 'Nope', goalCondition: GOOD_CONDITION, priority: 'urgent' },
    ]);

    expect(refused.status).toBe(400);
  });
});
