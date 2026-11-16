import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { LOG_TYPES } from '../config/settings.js';
import { MOD_ACTIONS, MOD_SOURCES } from '../db/schema.js';
import type { Actor } from '../services/commands/types.js';
import type { Services } from '../services/container.js';
import type { DashboardService } from '../services/dashboard.js';
import { MAX_TEMPBAN_MS, MAX_TIMEOUT_MS, type ModActor } from '../services/moderation/service.js';
import type { ActionResponse } from '../shared/api.js';
import { formatDuration, parseDuration } from '../shared/commandOptions.js';
import { gate, HttpError, parseInput, requireActor } from './http.js';

const snowflake = z.string().regex(/^\d{17,20}$/, 'must be a Discord ID');
const reason = z.string().trim().max(500).optional();
const duration = (max: number, min = 0) =>
  z.union([z.number().int().positive(), z.string()]).transform((v, ctx) => {
    const ms = typeof v === 'number' ? v : parseDuration(v);
    if (ms === null || ms < min || ms > max) {
      ctx.addIssue({
        code: 'custom',
        message: `must be a duration between ${formatDuration(min || 1000)} and ${formatDuration(max)}`,
      });
      return z.NEVER;
    }
    return ms;
  });

const modActor = (a: Actor): ModActor => ({
  userId: a.userId,
  displayName: a.displayName,
  isOwner: a.isOwner,
  highestRolePosition: a.highestRolePosition,
  source: 'dashboard',
});

/** Protected dashboard routes (mounted under /api with authentication and CSRF hooks). */
export function registerDashboardRoutes(
  api: FastifyInstance,
  services: Services,
  dashboard: DashboardService,
): void {
  const userParam = (req: FastifyRequest) => parseInput(z.object({ id: snowflake }), req.params).id;

  api.get('/overview', async (req) => dashboard.overview(requireActor(req)));

  api.get('/members', async (req) => {
    const q = parseInput(
      z.object({
        search: z.string().max(100).optional(),
        sort: z.enum(['name', 'tenure', 'activity', 'warnings']).optional(),
        order: z.enum(['asc', 'desc']).optional(),
        page: z.coerce.number().int().min(1).optional(),
        pageSize: z.coerce.number().int().min(1).max(100).optional(),
      }),
      req.query,
    );
    return dashboard.listMembers(requireActor(req), q);
  });

  api.get('/members/:id', async (req) => {
    const detail = await dashboard.memberDetail(requireActor(req), userParam(req));
    if (!detail) throw new HttpError(404, 'User not found.');
    return detail;
  });

  api.get('/roles', async (req) => dashboard.roles(requireActor(req)));

  // ── Member actions: same services and permission nodes as the slash commands ──

  const audit = (req: FastifyRequest, action: string, target: string, body: unknown) =>
    services.audit.record(
      { id: requireActor(req).userId, source: 'dashboard' },
      { action, target, after: body },
    );

  api.post(
    '/members/:id/warn',
    { preHandler: gate(services, 'admin:warn') },
    async (req): Promise<ActionResponse> => {
      const id = userParam(req);
      const body = parseInput(z.object({ reason: z.string().trim().min(1).max(500) }), req.body);
      const r = await services.moderation.warn(modActor(requireActor(req)), {
        userId: id,
        reason: body.reason,
      });
      audit(req, 'dashboard.member.warn', id, body);
      return {
        ok: true,
        caseNumber: r.case.caseNumber,
        message: `Warned (${r.activeWarnings} active warning(s)).`,
      };
    },
  );

  api.post(
    '/members/:id/timeout',
    { preHandler: gate(services, 'admin:timeout') },
    async (req): Promise<ActionResponse> => {
      const id = userParam(req);
      const body = parseInput(z.object({ duration: duration(MAX_TIMEOUT_MS, 60_000), reason }), req.body);
      const r = await services.moderation.timeout(modActor(requireActor(req)), {
        userId: id,
        durationMs: body.duration,
        ...(body.reason ? { reason: body.reason } : {}),
      });
      audit(req, 'dashboard.member.timeout', id, body);
      return {
        ok: true,
        caseNumber: r.case.caseNumber,
        message: `Timed out for ${formatDuration(body.duration)}.`,
      };
    },
  );

  api.post(
    '/members/:id/untimeout',
    { preHandler: gate(services, 'admin:untimeout') },
    async (req): Promise<ActionResponse> => {
      const id = userParam(req);
      const body = parseInput(z.object({ reason }), req.body);
      const c = await services.moderation.untimeout(modActor(requireActor(req)), {
        userId: id,
        ...(body.reason ? { reason: body.reason } : {}),
      });
      audit(req, 'dashboard.member.untimeout', id, body);
      return { ok: true, caseNumber: c.caseNumber, message: 'Timeout removed.' };
    },
  );

  api.post(
    '/members/:id/kick',
    { preHandler: gate(services, 'admin:kick') },
    async (req): Promise<ActionResponse> => {
      const id = userParam(req);
      const body = parseInput(z.object({ reason }), req.body);
      const r = await services.moderation.kick(modActor(requireActor(req)), {
        userId: id,
        ...(body.reason ? { reason: body.reason } : {}),
      });
      audit(req, 'dashboard.member.kick', id, body);
      return { ok: true, caseNumber: r.case.caseNumber, message: 'Kicked.' };
    },
  );

  api.post(
    '/members/:id/ban',
    { preHandler: gate(services, 'admin:ban') },
    async (req): Promise<ActionResponse> => {
      const id = userParam(req);
      const body = parseInput(
        z.object({
          reason,
          duration: duration(MAX_TEMPBAN_MS).optional(),
          deleteDays: z.number().int().min(0).max(7).optional(),
        }),
        req.body,
      );
      const r = await services.moderation.ban(modActor(requireActor(req)), {
        userId: id,
        ...(body.reason ? { reason: body.reason } : {}),
        ...(body.duration ? { durationMs: body.duration } : {}),
        ...(body.deleteDays ? { deleteDays: body.deleteDays } : {}),
      });
      audit(req, 'dashboard.member.ban', id, body);
      return {
        ok: true,
        caseNumber: r.case.caseNumber,
        message: body.duration ? `Banned for ${formatDuration(body.duration)}.` : 'Banned.',
      };
    },
  );

  api.post(
    '/members/:id/roles',
    { preHandler: gate(services, 'admin:role') },
    async (req): Promise<ActionResponse> => {
      const id = userParam(req);
      const body = parseInput(z.object({ roleId: snowflake, add: z.boolean() }), req.body);
      const c = await services.moderation.changeRole(modActor(requireActor(req)), { userId: id, ...body });
      audit(req, body.add ? 'dashboard.member.role_add' : 'dashboard.member.role_remove', id, body);
      return { ok: true, caseNumber: c.caseNumber, message: body.add ? 'Role added.' : 'Role removed.' };
    },
  );

  // ── Moderation cases (same node as /case) ──

  api.get('/cases', { preHandler: gate(services, 'admin:case') }, async (req) => {
    const q = parseInput(
      z.object({
        action: z.enum(MOD_ACTIONS).optional(),
        target: snowflake.optional(),
        moderator: snowflake.optional(),
        source: z.enum(MOD_SOURCES).optional(),
        before: z.coerce.number().int().min(1).optional(),
        limit: z.coerce.number().int().min(1).max(200).optional(),
      }),
      req.query,
    );
    return dashboard.listCases({
      ...(q.action ? { action: q.action } : {}),
      ...(q.target ? { targetId: q.target } : {}),
      ...(q.moderator ? { moderatorId: q.moderator } : {}),
      ...(q.source ? { source: q.source } : {}),
      ...(q.before ? { before: q.before } : {}),
      ...(q.limit ? { limit: q.limit } : {}),
    });
  });

  api.get('/cases/:n', { preHandler: gate(services, 'admin:case') }, async (req) => {
    const { n } = parseInput(z.object({ n: z.coerce.number().int().min(1) }), req.params);
    const c = services.moderation.cases.get(n);
    if (!c) throw new HttpError(404, `Case #${n} does not exist.`);
    const [dto] = dashboard.caseDtos([c]);
    return { case: dto, mentions: dashboard.mentions([dto!.reason]) };
  });

  // ── Logs (may contain deleted message content, so they have their own node) ──

  api.get('/logs', { preHandler: gate(services, 'dashboard:logs') }, async (req) => {
    const q = parseInput(
      z.object({
        type: z.enum(LOG_TYPES).optional(),
        user: snowflake.optional(),
        channel: snowflake.optional(),
        q: z.string().max(200).optional(),
        from: z.coerce.date().optional(),
        to: z.coerce.date().optional(),
        before: z.coerce.number().int().min(1).optional(),
        limit: z.coerce.number().int().min(1).max(200).optional(),
      }),
      req.query,
    );
    return dashboard.listLogs({
      ...(q.type ? { type: q.type } : {}),
      ...(q.user ? { userId: q.user } : {}),
      ...(q.channel ? { channelId: q.channel } : {}),
      ...(q.q ? { search: q.q } : {}),
      ...(q.from ? { from: q.from } : {}),
      ...(q.to ? { to: q.to } : {}),
      ...(q.before ? { before: q.before } : {}),
      ...(q.limit ? { limit: q.limit } : {}),
    });
  });
}
