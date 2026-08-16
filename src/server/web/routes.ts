import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { FastifyInstance } from 'fastify';

/**
 * Serves the Phase 0 event page.
 *
 * One file, read from disk on each request so editing it during the
 * verification run does not require a restart. It is thrown away in Phase 1,
 * so no bundler and no static-file plugin.
 */

function resolvePagePath(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, '../../../src/web/index.html'),
    resolve(here, '../../../../src/web/index.html'),
    join(here, 'index.html'),
  ];

  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

export function registerWebRoutes(app: FastifyInstance): void {
  app.get('/', (_request, reply) => {
    const path = resolvePagePath();

    if (path === null) {
      return reply
        .code(404)
        .type('text/plain')
        .send('Event page not found. Expected src/web/index.html beside the installed package.');
    }

    return reply.type('text/html; charset=utf-8').send(readFileSync(path, 'utf8'));
  });
}
