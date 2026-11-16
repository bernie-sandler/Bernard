import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyBaseLogger, LogController } from 'fastify';
import type { Env } from '../config/env.js';
import type { Logger } from '../logger.js';
import type { Container } from '../services/container.js';
import { DashboardService, type JobInfo } from '../services/dashboard.js';
import { createAuth } from './auth.js';
import { errorHandler } from './http.js';
import { registerManagementRoutes } from './manage.js';
import { DiscordOAuthClient, type OAuthClient } from './oauth.js';
import { registerDashboardRoutes } from './routes.js';

export interface ApiDeps {
  env: Env;
  logger: Logger;
  container: Container;
  startedAt: Date;
  /** Override the Discord OAuth client (tests). */
  oauth?: OAuthClient;
  /** Scheduled job status for the overview page. */
  jobs?: () => JobInfo[];
  /** Directory with the built dashboard (default dist/web). */
  webRoot?: string;
}

const CSP = [
  "default-src 'self'",
  "img-src 'self' data: https://cdn.discordapp.com https://media.discordapp.net",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self'",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

/** Fastify app sharing the bot's process and services: health check, dashboard API and static UI. */
export async function createApiServer(deps: ApiDeps) {
  const { env, container } = deps;
  const { services } = container;
  const app = Fastify({
    // pino's Logger is a FastifyBaseLogger; the cast keeps the instance type compatible with route helpers.
    loggerInstance: deps.logger.child({ component: 'api' }) as FastifyBaseLogger,
    trustProxy: toFastifyTrustProxy(env.TRUST_PROXY),
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: 256 * 1024,
  });

  app.decorateRequest('actor', null);
  app.decorateRequest('session', null);
  app.setErrorHandler(errorHandler(deps.logger));

  app.addHook('onSend', async (_req, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'same-origin');
    reply.header('Content-Security-Policy', CSP);
    if (env.COOKIE_SECURE) reply.header('Strict-Transport-Security', 'max-age=15552000');
  });

  app.get('/healthz', async (_req, reply) => {
    const ready = services.bot.isReady();
    return reply.code(ready ? 200 : 503).send({
      status: ready ? 'ok' : 'starting',
      discord: { ready, pingMs: ready ? services.bot.wsPingMs() : null },
      uptimeSec: Math.round((Date.now() - deps.startedAt.getTime()) / 1000),
    });
  });

  if (!env.DASHBOARD_ENABLED) return app;

  await app.register(cookie, { secret: env.SESSION_SECRET! });
  await app.register(rateLimit, { max: 300, timeWindow: '1 minute' });

  const oauth =
    deps.oauth ??
    new DiscordOAuthClient(
      env.DISCORD_CLIENT_ID,
      env.DISCORD_CLIENT_SECRET!,
      `${env.PUBLIC_BASE_URL}/api/auth/callback`,
    );
  const auth = createAuth({ env, services, oauth, logger: deps.logger });
  const dashboard = new DashboardService(services, deps.jobs);

  auth.registerPublicRoutes(app);
  await app.register(
    async (api) => {
      api.addHook('preHandler', auth.authenticate);
      api.addHook('preHandler', auth.csrf);
      auth.registerMe(api);
      registerDashboardRoutes(api, services, dashboard);
      registerManagementRoutes(api, services, dashboard, container.executor);
    },
    { prefix: '/api' },
  );

  // Built dashboard (single-page app). Missing in development, where Vite serves it instead.
  const webRoot = resolve(deps.webRoot ?? 'dist/web');
  const hasWeb = existsSync(resolve(webRoot, 'index.html'));
  if (hasWeb) {
    await app.register(fastifyStatic, {
      root: webRoot,
      // Look files up on each request (not a list fixed at startup), so a rebuilt bundle is served.
      wildcard: true,
      // Vite fingerprints files in assets/, so they can be cached forever; index.html must revalidate.
      setHeaders: (res, path) => {
        const immutable = /[\\/]assets[\\/]/.test(path);
        res.header('Cache-Control', immutable ? 'public, max-age=31536000, immutable' : 'no-cache');
      },
    });
  }
  app.setNotFoundHandler((req, reply) => {
    const path = req.url.split('?')[0]!;
    // Client-side routes (no file extension) get the app shell; missing files stay real 404s.
    if (req.method === 'GET' && hasWeb && !path.startsWith('/api/') && !/\.[a-z0-9]+$/i.test(path)) {
      return reply.header('Cache-Control', 'no-cache').sendFile('index.html');
    }
    return reply.code(404).send({ error: 'Not found.' });
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
