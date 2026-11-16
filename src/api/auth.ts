import { randomBytes } from 'node:crypto';
import type {} from '@fastify/cookie';
import type {} from '@fastify/rate-limit';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Env } from '../config/env.js';
import type { MemberInfo } from '../discord/ports.js';
import type { Logger } from '../logger.js';
import type { Actor } from '../services/commands/types.js';
import type { Services } from '../services/container.js';
import { safeEqual } from '../services/sessions.js';
import type { MeResponse } from '../shared/api.js';
import { HttpError, requireActor } from './http.js';
import { avatarUrl, type OAuthClient } from './oauth.js';

export const SESSION_COOKIE = 'bernard_session';
export const STATE_COOKIE = 'bernard_oauth_state';
const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function actorFromMember(m: MemberInfo): Actor {
  return {
    userId: m.userId,
    username: m.username,
    displayName: m.displayName,
    roleIds: m.roleIds,
    isOwner: m.isOwner,
    isAdministrator: m.isAdministrator,
    highestRolePosition: m.highestRolePosition,
  };
}

export interface AuthDeps {
  env: Env;
  services: Services;
  oauth: OAuthClient;
  logger: Logger;
}

export function createAuth(deps: AuthDeps) {
  const { env, services, oauth, logger } = deps;
  const baseOrigin = new URL(env.PUBLIC_BASE_URL).origin;
  const cookieBase = { httpOnly: true, sameSite: 'lax' as const, secure: env.COOKIE_SECURE, signed: true };

  function readSignedCookie(req: FastifyRequest, name: string): string | null {
    const raw = req.cookies[name];
    if (!raw) return null;
    const r = req.unsignCookie(raw);
    return r.valid ? r.value : null;
  }

  function clearSession(reply: FastifyReply): void {
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
  }

  const loginRedirect = (reply: FastifyReply, error: string) =>
    reply.redirect(`/login?error=${encodeURIComponent(error)}`);

  /** Public routes: start login and handle Discord's callback. */
  function registerPublicRoutes(app: FastifyInstance): void {
    const strict = { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } };

    app.get('/api/auth/login', strict, async (_req, reply) => {
      const state = randomBytes(24).toString('base64url');
      reply.setCookie(STATE_COOKIE, state, { ...cookieBase, path: '/api/auth', maxAge: 600 });
      return reply.redirect(oauth.authorizeUrl(state));
    });

    app.get<{ Querystring: { code?: string; state?: string; error?: string } }>(
      '/api/auth/callback',
      strict,
      async (req, reply) => {
        const expected = readSignedCookie(req, STATE_COOKIE);
        reply.clearCookie(STATE_COOKIE, { path: '/api/auth' });
        if (req.query.error) return loginRedirect(reply, 'cancelled');
        if (!req.query.code || !req.query.state || !expected || !safeEqual(req.query.state, expected)) {
          return loginRedirect(reply, 'state');
        }
        let user: Awaited<ReturnType<OAuthClient['identify']>>;
        try {
          user = await oauth.identify(req.query.code);
        } catch (err) {
          logger.warn({ err }, 'Discord OAuth exchange failed');
          return loginRedirect(reply, 'discord');
        }
        const member = await services.guild.getMember(user.id);
        if (!member) return loginRedirect(reply, 'not_member');
        if (!services.permissions.check(actorFromMember(member), 'dashboard:access').allowed) {
          return loginRedirect(reply, 'forbidden');
        }
        const { rawId } = services.sessions.create({
          userId: user.id,
          username: user.global_name ?? user.username,
          avatar: avatarUrl(user),
        });
        reply.setCookie(SESSION_COOKIE, rawId, {
          ...cookieBase,
          path: '/',
          maxAge: services.sessions.ttlSeconds,
        });
        services.audit.record(
          { id: user.id, source: 'dashboard' },
          { action: 'dashboard.login', target: user.id },
        );
        return reply.redirect('/');
      },
    );

    // Logout only needs a session (even one that lost dashboard access, which can't fetch its CSRF
    // token) plus either the CSRF token or a same-origin Origin header.
    app.post('/api/auth/logout', async (req, reply) => {
      const raw = readSignedCookie(req, SESSION_COOKIE);
      const session = raw ? services.sessions.get(raw) : null;
      if (raw && session) {
        const token = req.headers['x-csrf-token'];
        const tokenOk = typeof token === 'string' && safeEqual(token, session.csrfToken);
        if (!tokenOk && req.headers.origin !== baseOrigin) {
          throw new HttpError(403, 'Invalid CSRF token.');
        }
        services.sessions.destroy(raw);
      }
      clearSession(reply);
      return { ok: true };
    });
  }

  /**
   * preHandler for every protected route: a valid session, current server membership and
   * dashboard:access (re-checked on every request, so removing a role takes effect immediately).
   */
  async function authenticate(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const raw = readSignedCookie(req, SESSION_COOKIE);
    const session = raw ? services.sessions.get(raw) : null;
    if (!raw || !session) {
      clearSession(reply);
      throw new HttpError(401, 'Not logged in.');
    }
    const member = await services.guild.getMember(session.userId);
    if (!member) {
      services.sessions.destroy(raw);
      clearSession(reply);
      throw new HttpError(401, 'You are no longer a member of the server.');
    }
    const actor = actorFromMember(member);
    if (!services.permissions.check(actor, 'dashboard:access').allowed) {
      throw new HttpError(403, "You don't have permission (dashboard:access).", 'dashboard:access');
    }
    req.actor = actor;
    req.session = session;
  }

  /** CSRF protection for state-changing requests: same-origin check plus a per-session token. */
  async function csrf(req: FastifyRequest): Promise<void> {
    if (!UNSAFE.has(req.method)) return;
    const origin = req.headers.origin;
    if (origin && origin !== baseOrigin) throw new HttpError(403, 'Cross-origin request blocked.');
    const token = req.headers['x-csrf-token'];
    if (typeof token !== 'string' || !req.session || !safeEqual(token, req.session.csrfToken)) {
      throw new HttpError(403, 'Invalid CSRF token. Reload the page and try again.');
    }
  }

  /** Protected: who am I, plus what I'm allowed to do. */
  function registerMe(app: FastifyInstance): void {
    app.get('/auth/me', async (req): Promise<MeResponse> => {
      const actor = requireActor(req);
      const member = await services.guild.getMember(actor.userId);
      const summary = services.guild.summary();
      const allowedNodes = services.registry
        .allNodes()
        .map((n) => n.node)
        .filter((n) => n !== '*' && !n.endsWith(':*'))
        .filter((n) => services.permissions.check(actor, n).allowed);
      return {
        user: {
          id: actor.userId,
          username: actor.username,
          displayName: actor.displayName,
          avatarUrl: member?.avatarUrl ?? req.session?.user.avatar ?? null,
        },
        csrfToken: req.session!.csrfToken,
        allowedNodes,
        guild: { name: summary.name, iconUrl: summary.iconUrl },
      };
    });
  }

  return { registerPublicRoutes, authenticate, csrf, registerMe };
}
