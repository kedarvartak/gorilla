import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '../src/server/app.js';
import { openDatabase, type DatabaseHandle } from '../src/server/db/client.js';
import type { ExecutionPolicy } from '../src/server/cards/policy.js';

/**
 * The project's execution policy.
 *
 * The claim under test is that a card inherits how it runs from the project,
 * so readying a task is describing work rather than configuring a runtime -
 * and that what a caller states explicitly is never overwritten by it.
 */

let dir: string;
let database: DatabaseHandle;
let app: FastifyInstance;
let boardId: string;

async function json<T>(
  method: 'GET' | 'POST' | 'PUT' | 'PATCH',
  url: string,
  payload?: unknown,
): Promise<{ status: number; body: T }> {
  const response = await app.inject({
    method,
    url,
    ...(payload === undefined ? {} : { payload: payload as object }),
  });
  return {
    status: response.statusCode,
    body: response.body === '' ? (undefined as T) : (response.json() as T),
  };
}

interface CardShape {
  readonly id: string;
  readonly agentProvider: string;
  readonly agentModel: string | null;
  readonly agentEffort: string | null;
  readonly tokenCeiling: number | null;
  readonly guardrails: { verify: string | null };
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'gorilla-policy-'));
  database = openDatabase({ path: join(dir, 'policy.db') });
  app = buildApp({ database, logger: false });
  await app.ready();
  const board = await json<{ id: string }>('POST', '/api/boards', { name: 't', cwd: dir });
  boardId = board.body.id;
});

afterEach(async () => {
  await app.close();
  database.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('the project execution policy', () => {
  it('starts as the provider default rather than as a choice nobody made', async () => {
    const read = await json<ExecutionPolicy>('GET', `/api/boards/${boardId}/policy`);

    expect(read.body).toEqual({
      provider: 'claude',
      model: null,
      effort: null,
      permissionMode: null,
      verify: null,
      setup: null,
      tokenCeiling: null,
    });
  });

  it('stores what the operator set and reads it back', async () => {
    const written = await json<ExecutionPolicy>('PUT', `/api/boards/${boardId}/policy`, {
      provider: 'claude',
      model: 'sonnet',
      effort: 'high',
      verify: 'npm test',
      setup: 'npm ci',
      tokenCeiling: 500_000,
    });

    expect(written.status).toBe(200);
    expect(written.body.model).toBe('sonnet');

    const read = await json<ExecutionPolicy>('GET', `/api/boards/${boardId}/policy`);
    expect(read.body.setup).toBe('npm ci');
    expect(read.body.tokenCeiling).toBe(500_000);
  });

  it('refuses a ceiling of zero rather than reading it as no ceiling', async () => {
    const refused = await json<{ field: string }>('PUT', `/api/boards/${boardId}/policy`, {
      tokenCeiling: 0,
    });

    expect(refused.status).toBe(400);
    expect(refused.body.field).toBe('tokenCeiling');
  });

  it('refuses a provider it cannot dispatch to', async () => {
    const refused = await json<{ field: string }>('PUT', `/api/boards/${boardId}/policy`, {
      provider: 'gpt',
    });

    expect(refused.status).toBe(400);
    expect(refused.body.field).toBe('provider');
  });
});

describe('a card created under a policy', () => {
  beforeEach(async () => {
    await json('PUT', `/api/boards/${boardId}/policy`, {
      provider: 'codex',
      model: 'gpt-5.5',
      effort: 'high',
      verify: 'npm test',
      tokenCeiling: 400_000,
    });
  });

  it('takes the project settings without anyone typing them', async () => {
    const created = await json<CardShape>('POST', `/api/boards/${boardId}/cards`, {
      title: 'Reset email endpoint',
      goalCondition:
        'The endpoint returns 202, shown by running `npm test`, or stop after 20 turns',
    });

    expect(created.body.agentProvider).toBe('codex');
    expect(created.body.agentModel).toBe('gpt-5.5');
    expect(created.body.agentEffort).toBe('high');
    expect(created.body.tokenCeiling).toBe(400_000);
    expect(created.body.guardrails.verify).toBe('npm test');
  });

  it('never overwrites what the caller stated', async () => {
    const created = await json<CardShape>('POST', `/api/boards/${boardId}/cards`, {
      title: 'One-off on another agent',
      agentProvider: 'claude',
      agentModel: 'opus',
      guardrails: { verify: 'npm run test:e2e' },
    });

    expect(created.body.agentProvider).toBe('claude');
    expect(created.body.agentModel).toBe('opus');
    expect(created.body.guardrails.verify).toBe('npm run test:e2e');
    // Not stated, so still the project's.
    expect(created.body.agentEffort).toBe('high');
  });

  it('reaches cards posted by a planning conversation', async () => {
    const plan = await json<{ created: { id: string }[] }>('POST', `/api/boards/${boardId}/plans`, {
      prompt: 'password reset',
      cards: [
        {
          title: 'Token expiry',
          goalCondition: 'Expired tokens are rejected, shown by `npm test`, or stop after 20 turns',
        },
      ],
    });

    expect(plan.status).toBe(201);
    const posted = await json<CardShape>('GET', `/api/cards/${plan.body.created[0]?.id ?? ''}`);
    expect(posted.body.agentModel).toBe('gpt-5.5');
    expect(posted.body.guardrails.verify).toBe('npm test');
  });

  it('does not reach cards that already existed', async () => {
    const before = await json<CardShape>('POST', `/api/boards/${boardId}/cards`, {
      title: 'Created under the old policy',
    });

    await json('PUT', `/api/boards/${boardId}/policy`, { provider: 'claude', model: 'haiku' });

    const read = await json<CardShape>('GET', `/api/cards/${before.body.id}`);
    expect(read.body.agentModel).toBe('gpt-5.5');
  });
});
