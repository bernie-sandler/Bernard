import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { LOG_TYPES, type LogType } from '../config/settings.js';
import type { CommandExecutor } from '../services/commands/executor.js';
import type { FlatCommand } from '../services/commands/registry.js';
import type { Services } from '../services/container.js';
import type { DashboardService } from '../services/dashboard.js';
import { describeDecision } from '../services/permissions/resolver.js';
import type { SyncSummary } from '../services/tiers.js';
import { MAX_TIERS } from '../services/tiers.js';
import type {
  AuditListResponse,
  ChannelDto,
  CommandDto,
  CommandOptionDto,
  HubDto,
  PermissionCheckResponse,
  PermissionsResponse,
  RunCommandResponse,
  SettingsResponse,
  SettingsSection,
  SyncSummaryDto,
  TiersResponse,
  VoiceResponse,
} from '../shared/api.js';
import { COLORS } from '../shared/commandResult.js';
import { gate, HttpError, parseInput, requireActor } from './http.js';

const snowflake = z.string().regex(/^\d{17,20}$/, 'must be a Discord ID');

/** Which permission node edits each settings section (matching its slash command where one exists). */
export const SECTION_NODES: Record<SettingsSection, string> = {
  logs: 'config:logs',
  voice: 'config:voice',
  activity: 'config:activity',
  tenure: 'config:activity',
  tiers: 'config:tiers',
  moderation: 'config:settings',
  permissions: 'config:settings',
};

function toOptionDto(name: string, d: FlatCommand['leaf']['options'][string]): CommandOptionDto {
  const dto: CommandOptionDto = {
    name,
    kind: d.kind,
    description: d.description,
    required: d.required || (d.kind === 'channel' && d.contextDefault === 'current'),
  };
  if ((d.kind === 'string' || d.kind === 'integer') && d.choices?.length) dto.choices = d.choices;
  if (d.kind === 'string') {
    if (d.autocomplete) dto.autocomplete = true;
    if (d.multiline) dto.multiline = true;
    if (d.minLength !== undefined) dto.minLength = d.minLength;
    if (d.maxLength !== undefined) dto.maxLength = d.maxLength;
  }
  if (d.kind === 'integer' || d.kind === 'number') {
    if (d.min !== undefined) dto.min = d.min;
    if (d.max !== undefined) dto.max = d.max;
  }
  if (d.kind === 'channel' && d.channelTypes) dto.channelTypes = d.channelTypes;
  return dto;
}

function toCommandDto(c: FlatCommand): CommandDto {
  const options = Object.entries(c.leaf.options).map(([n, d]) => toOptionDto(n, d));
  return {
    fullName: c.fullName,
    description: c.leaf.description,
    node: c.leaf.node,
    category: c.leaf.node.split(':')[0]!,
    // Required fields first, like Discord.
    options: [...options.filter((o) => o.required), ...options.filter((o) => !o.required)],
  };
}

const syncDto = (s: SyncSummary | null): SyncSummaryDto | null =>
  s
    ? {
        at: s.at,
        reason: s.reason,
        basis: s.basis ?? 'full',
        members: s.members,
        changed: s.changed,
        skipped: s.skipped,
        errors: s.errors,
      }
    : null;

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Management routes for phase 6 (mounted under /api with authentication and CSRF hooks). */
export function registerManagementRoutes(
  api: FastifyInstance,
  services: Services,
  dashboard: DashboardService,
  executor: CommandExecutor,
): void {
  const auditActor = (req: FastifyRequest) => ({
    id: requireActor(req).userId,
    source: 'dashboard' as const,
  });
  const can = (req: FastifyRequest, node: string) =>
    services.permissions.check(requireActor(req), node).allowed;
  const idParam = (req: FastifyRequest) => parseInput(z.object({ id: snowflake }), req.params).id;

  api.get(
    '/channels',
    async (): Promise<ChannelDto[]> =>
      services.guild
        .listChannels()
        .map((c) => ({ id: c.id, name: c.name, kind: c.kind, parentId: c.parentId })),
  );

  // ── Command runner: the same executor as slash commands, with source=dashboard ──

  api.get('/commands', async (req): Promise<CommandDto[]> => {
    const actor = requireActor(req);
    return services.registry
      .all()
      .filter((c) => c.leaf.dashboard !== false && services.permissions.check(actor, c.leaf.node).allowed)
      .map(toCommandDto);
  });

  api.get('/commands/autocomplete', async (req) => {
    const q = parseInput(
      z.object({
        command: z.string().max(100),
        option: z.string().max(32),
        q: z.string().max(100).default(''),
      }),
      req.query,
    );
    const command = services.registry.find(q.command);
    const handler = command?.leaf.autocomplete?.[q.option];
    if (!command || !handler) return [];
    const actor = requireActor(req);
    if (!services.permissions.check(actor, command.leaf.node).allowed) return [];
    const choices = await handler({ guildId: services.guild.guildId, actor, services }, q.q);
    return choices.slice(0, 25);
  });

  api.post('/commands/run', async (req): Promise<RunCommandResponse> => {
    const body = parseInput(
      z.object({ command: z.string().max(100), input: z.record(z.string(), z.unknown()).default({}) }),
      req.body,
    );
    const command = services.registry.find(body.command);
    if (!command) throw new HttpError(404, `Unknown command /${body.command}.`);
    const { result, outcome } = await executor.run({
      command,
      actor: requireActor(req),
      source: 'dashboard',
      rawInput: body.input,
    });
    services.audit.record(auditActor(req), {
      action: 'dashboard.command',
      target: command.fullName,
      after: { input: body.input, outcome },
    });
    const texts = [
      result.content,
      ...(result.embeds ?? []).flatMap((e) => [
        e.title,
        e.description,
        ...(e.fields ?? []).map((f) => f.value),
      ]),
    ];
    return { outcome, result, mentions: dashboard.mentions(texts) };
  });

  // ── Permissions (same nodes as /permlist, /permset, /permunset, /permcheck) ──

  api.get(
    '/permissions',
    { preHandler: gate(services, 'config:permlist') },
    async (): Promise<PermissionsResponse> => ({
      roles: [
        { id: services.guild.guildId, name: '@everyone', color: 0, position: 0, isEveryone: true },
        ...services.guild.listRoles().map((r) => ({ ...r, isEveryone: false })),
      ],
      nodes: services.registry.allNodes(),
      rules: services.permissions
        .listRules()
        .map((r) => ({ roleId: r.roleId, node: r.node, allow: r.allow })),
      adminBypass: services.settings.get().permissions.adminBypass,
    }),
  );

  api.post('/permissions', async (req) => {
    const body = parseInput(
      z.object({ roleId: snowflake, node: z.string().max(70), value: z.boolean().nullable() }),
      req.body,
    );
    const node = body.value === null ? 'config:permunset' : 'config:permset';
    if (!can(req, node)) throw new HttpError(403, `You don't have permission (${node}).`, node);
    if (body.roleId !== services.guild.guildId && !services.guild.getRole(body.roleId)) {
      throw new HttpError(400, 'That role does not exist.');
    }
    if (body.value === null) {
      const removed = services.permissions.unsetRule(auditActor(req), body.roleId, body.node);
      return { ok: true, changed: removed };
    }
    services.permissions.setRule(auditActor(req), body.roleId, body.node, body.value);
    return { ok: true, changed: true };
  });

  api.post(
    '/permissions/check',
    { preHandler: gate(services, 'config:permcheck') },
    async (req): Promise<PermissionCheckResponse> => {
      const body = parseInput(z.object({ userId: snowflake, node: z.string().max(70) }), req.body);
      if (body.node === '*' || body.node.endsWith(':*') || !services.registry.isValidNode(body.node)) {
        throw new HttpError(400, 'Pick a concrete, registered node like admin:ban.');
      }
      const member = await services.guild.getMember(body.userId);
      if (!member) throw new HttpError(404, 'That user is not a member of the server.');
      const d = services.permissions.check(member, body.node);
      return {
        node: d.node,
        allowed: d.allowed,
        reason: d.reason,
        explanation: describeDecision(d, (id) => services.guild.roleName(id)),
        rule: d.rule ? { roleId: d.rule.roleId, node: d.rule.node, allow: d.rule.allow } : null,
        member: { id: member.userId, name: member.displayName, avatarUrl: member.avatarUrl },
      };
    },
  );

  // ── Tiers (config:tiers, same as /tiers) ──

  const tierGate = { preHandler: gate(services, 'config:tiers') };
  const tierBody = z.object({
    name: z.string().trim().min(1).max(50),
    roleId: snowflake,
    minTenureDays: z.number().int().min(0).max(36500),
    minActivity: z.number().min(0),
    position: z.number().int().min(1).max(MAX_TIERS).optional(),
  });
  const tierId = (req: FastifyRequest) =>
    parseInput(z.object({ id: z.coerce.number().int().min(1) }), req.params).id;

  api.get('/tiers', tierGate, async (): Promise<TiersResponse> => {
    const check = services.tiers.check();
    return {
      tiers: check.tiers.map((r) => {
        const role = services.guild.getRole(r.tier.roleId);
        return {
          id: r.tier.id,
          name: r.tier.name,
          roleId: r.tier.roleId,
          roleName: role?.name ?? null,
          roleColor: role?.color ?? 0,
          minTenureDays: r.tier.minTenureDays,
          minActivity: r.tier.minActivity,
          position: r.tier.position,
          members: r.members,
          manageable: r.manageable,
          problem: r.problem,
        };
      }),
      issues: check.issues,
      maxTiers: MAX_TIERS,
      lastSync: syncDto(services.tiers.lastSync()),
      lastTenureSync: syncDto(services.tiers.lastSync('tenure')),
    };
  });

  api.post('/tiers', tierGate, async (req) => {
    const body = parseInput(tierBody, req.body);
    return services.tiers.add(auditActor(req), {
      name: body.name,
      roleId: body.roleId,
      minTenureDays: body.minTenureDays,
      minActivity: body.minActivity,
      ...(body.position !== undefined ? { position: body.position } : {}),
    });
  });

  api.patch('/tiers/:id', tierGate, async (req) => {
    const body = parseInput(tierBody.partial(), req.body);
    const patch = Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined));
    return services.tiers.edit(auditActor(req), tierId(req), patch);
  });

  api.delete('/tiers/:id', tierGate, async (req) => {
    services.tiers.remove(auditActor(req), tierId(req));
    return { ok: true };
  });

  api.post('/tiers/reorder', tierGate, async (req) => {
    const body = parseInput(z.object({ ids: z.array(z.number().int()).max(MAX_TIERS) }), req.body);
    services.tiers.reorder(auditActor(req), body.ids);
    return { ok: true };
  });

  api.post('/tiers/sync', tierGate, async (req): Promise<SyncSummaryDto> => {
    const body = parseInput(z.object({ tenureOnly: z.boolean().default(false) }), req.body);
    if (services.tiers.list().length === 0) throw new HttpError(400, 'No tiers configured.');
    const who = requireActor(req).displayName;
    const s = await services.tiers.syncAll(
      body.tenureOnly ? `tenure-only sync by ${who} (dashboard)` : `manual sync by ${who} (dashboard)`,
      { tenureOnly: body.tenureOnly },
    );
    services.audit.record(auditActor(req), {
      action: body.tenureOnly ? 'dashboard.tiers.tenure_sync' : 'dashboard.tiers.sync',
      after: { members: s.members, changed: s.changed, skipped: s.skipped, errors: s.errors },
    });
    return syncDto(s)!;
  });

  // ── Voice hubs (config:voice, same as /voice) ──

  const voiceGate = { preHandler: gate(services, 'config:voice') };
  const hubBody = z.object({
    channelId: snowflake,
    type: z.enum(['public', 'private']),
    categoryId: snowflake,
    nameTemplate: z.string().trim().min(1).max(100).optional(),
    defaultLimit: z.number().int().min(0).max(99).optional(),
    hideFromEveryone: z.boolean().optional(),
  });
  const channelName = (id: string) => services.guild.getChannel(id)?.name ?? null;

  api.get('/voice', voiceGate, async (): Promise<VoiceResponse> => {
    const active = services.voice.activeChannels();
    const refs = dashboard.userRefs(active.flatMap((a) => [...a.members, ...(a.ownerId ? [a.ownerId] : [])]));
    return {
      hubs: services.voice.listHubs().map(
        (h): HubDto => ({
          channelId: h.channelId,
          channelName: channelName(h.channelId),
          type: h.type,
          categoryId: h.categoryId,
          categoryName: channelName(h.categoryId),
          nameTemplate: h.nameTemplate,
          defaultLimit: h.defaultLimit,
          hideFromEveryone: h.hideFromEveryone,
        }),
      ),
      active: active.map((a) => ({
        channelId: a.channelId,
        name: channelName(a.channelId) ?? a.channelId,
        hubChannelId: a.hubChannelId,
        owner: a.ownerId ? refs.get(a.ownerId)! : null,
        members: a.members.map((m) => refs.get(m)!),
      })),
    };
  });

  api.post('/voice/hubs', voiceGate, async (req) => {
    const body = parseInput(hubBody, req.body);
    return services.voice.addHub(auditActor(req), {
      channelId: body.channelId,
      type: body.type,
      categoryId: body.categoryId,
      ...(body.nameTemplate ? { nameTemplate: body.nameTemplate } : {}),
      ...(body.defaultLimit !== undefined ? { defaultLimit: body.defaultLimit } : {}),
      ...(body.hideFromEveryone !== undefined ? { hideFromEveryone: body.hideFromEveryone } : {}),
    });
  });

  api.patch('/voice/hubs/:id', voiceGate, async (req) => {
    const body = parseInput(hubBody.omit({ channelId: true }).partial(), req.body);
    const patch = Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined));
    return services.voice.editHub(auditActor(req), idParam(req), patch);
  });

  api.delete('/voice/hubs/:id', voiceGate, async (req) => {
    services.voice.removeHub(auditActor(req), idParam(req));
    return { ok: true };
  });

  // ── Settings: each section needs the node of its matching slash command ──

  api.get('/settings', async (req): Promise<SettingsResponse> => {
    const editable = Object.fromEntries(
      Object.entries(SECTION_NODES).map(([section, node]) => [section, can(req, node)]),
    ) as Record<SettingsSection, boolean>;
    return {
      settings: services.settings.get() as unknown as SettingsResponse['settings'],
      editable,
    };
  });

  api.patch('/settings/:section', async (req) => {
    const { section } = parseInput(
      z.object({ section: z.enum(Object.keys(SECTION_NODES) as [SettingsSection, ...SettingsSection[]]) }),
      req.params,
    );
    const node = SECTION_NODES[section];
    if (!can(req, node)) throw new HttpError(403, `You don't have permission (${node}).`, node);
    if (!isPlainObject(req.body)) throw new HttpError(400, 'Expected an object of settings to change.');
    const patch = req.body;

    // Like /logs set: prove the bot can post in a newly routed log channel before saving.
    if (section === 'logs' && isPlainObject(patch.channels)) {
      const current = services.settings.get().logs.channels;
      for (const [type, channelId] of Object.entries(patch.channels)) {
        if (!(LOG_TYPES as readonly string[]).includes(type)) continue;
        if (typeof channelId !== 'string' || channelId === current[type as LogType]) continue;
        const posted = await services.messenger
          .sendEmbed(channelId, {
            title: 'Log channel connected',
            description: `This channel now receives **${type}** logs (set from the dashboard).`,
            color: COLORS.success,
            footer: `Set by ${requireActor(req).displayName}`,
          })
          .catch(() => null);
        if (!posted) {
          throw new HttpError(
            400,
            `I can't post in #${channelName(channelId) ?? channelId}. Give me View Channel, Send Messages and Embed Links there.`,
          );
        }
      }
    }

    const next = services.settings.update(auditActor(req), `settings.${section}`, (draft) => {
      const target = draft[section] as Record<string, unknown>;
      for (const [k, v] of Object.entries(patch)) {
        const existing = target[k];
        // One level of merge (e.g. logs.channels), arrays and scalars replace.
        if (isPlainObject(v) && isPlainObject(existing)) Object.assign(existing, v);
        else target[k] = v;
      }
    });
    return { settings: next[section] };
  });

  // ── Audit log ──

  api.get(
    '/audit',
    { preHandler: gate(services, 'dashboard:audit') },
    async (req): Promise<AuditListResponse> => {
      const q = parseInput(
        z.object({
          actor: snowflake.optional(),
          action: z.string().max(60).optional(),
          source: z.enum(['slash', 'dashboard', 'system']).optional(),
          before: z.coerce.number().int().min(1).optional(),
          limit: z.coerce.number().int().min(1).max(200).optional(),
        }),
        req.query,
      );
      const limit = q.limit ?? 50;
      const rows = services.audit.list({
        limit: limit + 1,
        ...(q.before ? { beforeId: q.before } : {}),
        ...(q.actor ? { actorId: q.actor } : {}),
        ...(q.action ? { actionPrefix: q.action } : {}),
        ...(q.source ? { source: q.source } : {}),
      });
      const page = rows.slice(0, limit);
      const refs = dashboard.userRefs(page.map((r) => r.actorId).filter((id) => id !== 'system'));
      return {
        items: page.map((r) => ({
          id: r.id,
          actor:
            r.actorId === 'system'
              ? { id: 'system', name: 'System', avatarUrl: null }
              : (refs.get(r.actorId) ?? { id: r.actorId, name: r.actorId, avatarUrl: null }),
          source: r.source,
          action: r.action,
          target: r.target,
          targetLabel: dashboard.auditTargetLabel(r.action, r.target, r.before, r.after),
          before: r.before,
          after: r.after,
          createdAt: r.createdAt.toISOString(),
        })),
        nextBefore: rows.length > limit ? page.at(-1)!.id : null,
      };
    },
  );
}
