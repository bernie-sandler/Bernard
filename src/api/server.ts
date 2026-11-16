import Fastify, { LogController } from 'fastify';
import type { Env } from '../config/env.js';
import type { Logger } from '../logger.js';
import type { Container } from '../services/container.js';

export interface ApiDeps {
  env: Env;
  logger: Logger;
  container: Container;
  startedAt: Date;
}

/** Fastify app sharing the bot's process and services. Dashboard routes arrive in phase 5. */
export async function createApiServer(deps: ApiDeps) {
  const app = Fastify({
    loggerInstance: deps.logger.child({ component: 'api' }),
    trustProxy: toFastifyTrustProxy(deps.env.TRUST_PROXY),
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: 256 * 1024,
  });

  app.get('/healthz', async (_req, reply) => {
    const { bot } = deps.container.services;
    const ready = bot.isReady();
    return reply.code(ready ? 200 : 503).send({
      status: ready ? 'ok' : 'starting',
      discord: { ready, pingMs: ready ? bot.wsPingMs() : null },
      uptimeSec: Math.round((Date.now() - deps.startedAt.getTime()) / 1000),
    });
  });

  return app;
}

/** Fastify types lack hop counts, so express "trust N hops" as a function. */
function toFastifyTrustProxy(
  v: boolean | number | string[],
): boolean | string[] | ((addr: string, hop: number) => boolean) {
  if (typeof v === 'number') return (_addr, hop) => hop < v;
  return v;
}
export type ApiServer = Awaited<ReturnType<typeof createApiServer>>;
