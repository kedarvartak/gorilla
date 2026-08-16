import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { FastifyInstance } from 'fastify';

/**
 * Serves the built board interface.
 *
 * One process and one port, so `gorilla serve` stays a single command. No
 * static-file plugin: the asset set is a handful of files from our own build,
 * and a dependency to read them would be more surface than it saves.
 */

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
};

function resolveWebRoot(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  // Built output first. Running from source, `../../web` is Vite's *source*
  // directory, whose index.html has no built asset references - matching it
  // would serve a page that never loads.
  const candidates = [
    resolve(here, '../../../dist/web'),
    resolve(here, '../../../../dist/web'),
    resolve(here, '../../web'),
  ];

  return candidates.find((candidate) => existsSync(join(candidate, 'index.html'))) ?? null;
}

export function registerWebRoutes(app: FastifyInstance): void {
  const root = resolveWebRoot();

  const notBuilt = (): string =>
    'The board interface has not been built. Run `npm run build` and restart.';

  app.get('/', (_request, reply) => {
    if (root === null) return reply.code(503).type('text/plain').send(notBuilt());
    return reply.type('text/html; charset=utf-8').send(readFileSync(join(root, 'index.html')));
  });

  app.get<{ Params: { '*': string } }>('/assets/*', (request, reply) => {
    if (root === null) return reply.code(404).send({ error: 'Not built' });

    const requested = normalize(join(root, 'assets', request.params['*']));

    // Path traversal guard. The parameter is attacker-controlled in the sense
    // that anything on this machine can reach the port, and serving arbitrary
    // files from a process that reads transcripts is not a risk worth taking.
    if (!requested.startsWith(root + sep)) {
      return reply.code(403).send({ error: 'Forbidden' });
    }

    if (!existsSync(requested) || !statSync(requested).isFile()) {
      return reply.code(404).send({ error: 'Not found' });
    }

    return reply
      .type(CONTENT_TYPES[extname(requested)] ?? 'application/octet-stream')
      .send(readFileSync(requested));
  });
}
