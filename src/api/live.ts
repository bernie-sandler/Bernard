import type { ServerResponse } from 'node:http';
import type { FastifyInstance } from 'fastify';
import type { Services } from '../services/container.js';
import type { LiveTopic } from '../services/liveEvents.js';
import { HttpError, requireActor } from './http.js';

export interface LiveOptions {
  /** Comment line sent this often to keep proxies from closing the stream; also re-checks access. */
  heartbeatMs?: number;
  /** Topics published within this window are sent as one message. */
  coalesceMs?: number;
  /** Open streams allowed per user (several tabs). */
  maxPerUser?: number;
}

/**
 * GET /api/events: a Server-Sent Events stream of "topics changed" signals for the dashboard.
 * Messages carry only topic names; the dashboard refetches through the normal permission-checked
 * endpoints. Returns a function that ends every open stream (for shutdown).
 */
export function registerLiveRoutes(
  api: FastifyInstance,
  services: Services,
  opts: LiveOptions = {},
): () => void {
  const heartbeatMs = opts.heartbeatMs ?? 25_000;
  const coalesceMs = opts.coalesceMs ?? 400;
  const maxPerUser = opts.maxPerUser ?? 10;
  const open = new Map<ServerResponse, () => void>();
  const perUser = new Map<string, number>();

  api.get('/events', async (req, reply) => {
    const actor = requireActor(req);
    const session = req.session!;
    if ((perUser.get(actor.userId) ?? 0) >= maxPerUser) {
      throw new HttpError(429, 'Too many open dashboard tabs.');
    }

    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Nginx (Proxy Manager) buffers responses unless told not to.
      'X-Accel-Buffering': 'no',
      'X-Content-Type-Options': 'nosniff',
    });
    res.write('retry: 5000\n\n');
    res.write('event: ready\ndata: {}\n\n');
    perUser.set(actor.userId, (perUser.get(actor.userId) ?? 0) + 1);

    const pending = new Set<LiveTopic>();
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    const flush = () => {
      flushTimer = null;
      if (pending.size === 0 || res.writableEnded) return;
      res.write(`data: ${JSON.stringify({ topics: [...pending] })}\n\n`);
      pending.clear();
    };
    const unsubscribe = services.live.subscribe((topic) => {
      pending.add(topic);
      flushTimer ??= setTimeout(flush, coalesceMs);
    });

    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      if (flushTimer) clearTimeout(flushTimer);
      unsubscribe();
      open.delete(res);
      const n = (perUser.get(actor.userId) ?? 1) - 1;
      if (n <= 0) perUser.delete(actor.userId);
      else perUser.set(actor.userId, n);
      if (!res.writableEnded) res.end();
    };

    // Heartbeat, and end the stream once the session or dashboard access is gone.
    const heartbeat = setInterval(() => {
      void (async () => {
        try {
          if (!services.sessions.isActive(session.idHash)) return close();
          const member = await services.guild.getMember(session.userId);
          if (!member || !services.permissions.check(member, 'dashboard:access').allowed) return close();
          res.write(': ping\n\n');
        } catch {
          close();
        }
      })();
    }, heartbeatMs);
    heartbeat.unref?.();

    open.set(res, close);
    req.raw.on('close', close);
  });

  return () => {
    for (const close of [...open.values()]) close();
  };
}
