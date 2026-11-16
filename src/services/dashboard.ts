import { and, count, desc, eq, gte, inArray, lt, lte, or, type SQL, sql } from 'drizzle-orm';
import { LOG_TYPES, type LogType } from '../config/settings.js';
import { logs, members, modCases } from '../db/schema.js';
import type {
  CaseDto,
  CaseListResponse,
  LogListResponse,
  MemberDetailResponse,
  MemberListItem,
  MemberListResponse,
  MemberSort,
  Mentions,
  OverviewResponse,
  RoleDto,
  UserRef,
} from '../shared/api.js';
import type { Actor } from './commands/types.js';
import type { Services } from './container.js';
import { DAY_MS, tenureDays } from './members.js';
import { ACTION_LABELS, isChannelTarget, type ModCase } from './moderation/cases.js';

export interface JobInfo {
  name: string;
  lastRunAt: Date | null;
  lastError: string | null;
  nextRunAt: Date | null;
}

const MENTION = /<(@!?|@&|#)(\d{17,20})>/g;

/** Read-only queries behind the dashboard pages. Writes go through the domain services. */
export class DashboardService {
  constructor(
    private readonly s: Services,
    private readonly jobs: () => JobInfo[] = () => [],
  ) {}

  private can(actor: Actor, node: string): boolean {
    return this.s.permissions.check(actor, node).allowed;
  }

  // ── Names ────────────────────────────────────────────────────────────────

  private memberRows(ids: string[]) {
    if (ids.length === 0) return new Map<string, typeof members.$inferSelect>();
    const rows = this.s.db
      .select()
      .from(members)
      .where(and(eq(members.guildId, this.s.guild.guildId), inArray(members.userId, [...new Set(ids)])))
      .all();
    return new Map(rows.map((r) => [r.userId, r]));
  }

  userRefs(ids: string[]): Map<string, UserRef> {
    const rows = this.memberRows(ids);
    const out = new Map<string, UserRef>();
    for (const id of ids) {
      const row = rows.get(id);
      const cached = row ? null : this.s.guild.cachedMember(id);
      out.set(id, {
        id,
        name: row?.displayName ?? cached?.displayName ?? id,
        avatarUrl: row?.avatar ?? cached?.avatarUrl ?? null,
      });
    }
    return out;
  }

  /** Resolve <@id>, <@&id> and <#id> found in the given texts. */
  mentions(texts: (string | null | undefined)[]): Mentions {
    const users = new Set<string>();
    const roles = new Set<string>();
    const channels = new Set<string>();
    for (const t of texts) {
      if (!t) continue;
      for (const m of t.matchAll(MENTION)) {
        const kind = m[1]!;
        const id = m[2]!;
        if (kind === '@&') roles.add(id);
        else if (kind === '#') channels.add(id);
        else users.add(id);
      }
    }
    const out: Mentions = { users: {}, roles: {}, channels: {} };
    for (const [id, ref] of this.userRefs([...users])) if (ref.name !== id) out.users[id] = ref.name;
    for (const id of roles) {
      const r = this.s.guild.getRole(id);
      if (r) out.roles[id] = { name: r.name, color: r.color };
    }
    for (const id of channels) {
      const c = this.s.guild.getChannel(id);
      if (c) out.channels[id] = c.name;
    }
    return out;
  }

  caseDtos(rows: ModCase[]): CaseDto[] {
    const refs = this.userRefs(rows.flatMap((c) => [c.targetId, c.moderatorId]));
    return rows.map((c) => {
      const channel = isChannelTarget(c);
      return {
        caseNumber: c.caseNumber,
        action: c.action,
        label: ACTION_LABELS[c.action],
        targetId: c.targetId,
        targetType: channel ? 'channel' : 'user',
        targetName: channel
          ? (this.s.guild.getChannel(c.targetId)?.name ?? null)
          : (refs.get(c.targetId)?.name ?? null),
        moderatorId: c.moderatorId,
        moderatorName: c.source === 'system' ? 'System' : (refs.get(c.moderatorId)?.name ?? null),
        reason: c.reason,
        durationMs: c.durationMs,
        expiresAt: c.expiresAt?.toISOString() ?? null,
        source: c.source,
        active: c.active,
        data: c.data ?? null,
        createdAt: c.createdAt.toISOString(),
      };
    });
  }

  // ── Overview ─────────────────────────────────────────────────────────────

  async overview(actor: Actor, now = Date.now()): Promise<OverviewResponse> {
    const { guild, voice, activity, settings, moderation, tiers, bot } = this.s;
    const summary = guild.summary();
    const counts = await guild.approximateCounts();

    const days = Math.min(30, settings.get().logs.retentionDays);
    const since = new Date(now - (days - 1) * DAY_MS);
    since.setUTCHours(0, 0, 0, 0);
    const events = this.s.db
      .select({ event: logs.event, createdAt: logs.createdAt })
      .from(logs)
      .where(
        and(
          eq(logs.guildId, guild.guildId),
          eq(logs.type, 'members'),
          inArray(logs.event, ['member_join', 'member_leave']),
          gte(logs.createdAt, since),
        ),
      )
      .all();
    const buckets = new Map<string, { joins: number; leaves: number }>();
    for (let i = 0; i < days; i++) {
      buckets.set(new Date(since.getTime() + i * DAY_MS).toISOString().slice(0, 10), { joins: 0, leaves: 0 });
    }
    for (const e of events) {
      const b = buckets.get(e.createdAt.toISOString().slice(0, 10));
      if (!b) continue;
      if (e.event === 'member_join') b.joins++;
      else b.leaves++;
    }

    const active = voice.activeChannels();
    const top = activity.allTotals(now).slice(0, 10);
    const refs = this.userRefs([
      ...active.flatMap((a) => [...a.members, ...(a.ownerId ? [a.ownerId] : [])]),
      ...top.map((t) => t.userId),
    ]);
    const canViewCases = this.can(actor, 'admin:case');
    const last = tiers.lastSync();

    return {
      guild: {
        name: summary.name,
        iconUrl: summary.iconUrl,
        memberCount: counts?.members ?? summary.memberCount,
        onlineCount: counts?.online ?? null,
      },
      joinsLeaves: [...buckets.entries()].map(([date, v]) => ({ date, ...v })),
      voice: active.map((a) => ({
        channelId: a.channelId,
        name: guild.getChannel(a.channelId)?.name ?? a.channelId,
        owner: a.ownerId ? refs.get(a.ownerId)! : null,
        members: a.members.map((m) => refs.get(m)!),
      })),
      topMembers: top.map((t) => ({ ...refs.get(t.userId)!, ...t })),
      activityWindowDays: settings.get().activity.windowDays,
      recentCases: canViewCases ? this.caseDtos(moderation.cases.list({ limit: 10 })) : [],
      canViewCases,
      health: {
        ready: bot.isReady(),
        wsPingMs: bot.isReady() ? bot.wsPingMs() : null,
        botUptimeSec: Math.round(bot.uptimeMs() / 1000),
        processUptimeSec: Math.round(process.uptime()),
        lastTierSync: last
          ? { at: last.at, changed: last.changed, members: last.members, errors: last.errors }
          : null,
        jobs: this.jobs().map((j) => ({
          name: j.name,
          lastRunAt: j.lastRunAt?.toISOString() ?? null,
          lastError: j.lastError,
          nextRunAt: j.nextRunAt?.toISOString() ?? null,
        })),
      },
    };
  }

  // ── Members ──────────────────────────────────────────────────────────────

  private warningCounts(): Map<string, number> {
    const rows = this.s.db
      .select({ targetId: modCases.targetId, n: count() })
      .from(modCases)
      .where(
        and(
          eq(modCases.guildId, this.s.guild.guildId),
          eq(modCases.action, 'warn'),
          eq(modCases.active, true),
        ),
      )
      .groupBy(modCases.targetId)
      .all();
    return new Map(rows.map((r) => [r.targetId, r.n]));
  }

  listMembers(
    actor: Actor,
    q: { search?: string; sort?: MemberSort; order?: 'asc' | 'desc'; page?: number; pageSize?: number },
    now = Date.now(),
  ): MemberListResponse {
    const tiers = this.s.tiers.list();
    const scores = new Map(this.s.activity.allTotals(now).map((t) => [t.userId, t]));
    const showWarnings = this.can(actor, 'admin:warnings');
    const warnings = showWarnings ? this.warningCounts() : new Map<string, number>();
    const search = q.search?.trim().toLowerCase();

    let items: MemberListItem[] = this.s.members
      .listCurrent()
      .filter(
        (m) =>
          !search ||
          m.displayName.toLowerCase().includes(search) ||
          m.username.toLowerCase().includes(search) ||
          m.userId === search,
      )
      .map((m) => {
        const totals = scores.get(m.userId);
        const roleIds = this.s.guild.cachedMember(m.userId)?.roleIds ?? [];
        const tier = [...tiers].reverse().find((t) => roleIds.includes(t.roleId));
        return {
          userId: m.userId,
          displayName: m.displayName,
          username: m.username,
          avatarUrl: m.avatar,
          isBot: m.isBot,
          joinedAt: m.joinedAt.toISOString(),
          tenureDays: tenureDays(m.joinedAt, now),
          score: totals?.score ?? 0,
          messagePoints: totals?.messagePoints ?? 0,
          voiceMinutes: totals?.voiceMinutes ?? 0,
          tier: tier ? { name: tier.name, roleId: tier.roleId } : null,
          warnings: showWarnings ? (warnings.get(m.userId) ?? 0) : null,
        };
      });

    const sort = q.sort ?? 'activity';
    const dir = (q.order ?? (sort === 'name' ? 'asc' : 'desc')) === 'asc' ? 1 : -1;
    const key: Record<MemberSort, (m: MemberListItem) => number | string> = {
      name: (m) => m.displayName.toLowerCase(),
      tenure: (m) => m.tenureDays,
      activity: (m) => m.score,
      warnings: (m) => m.warnings ?? 0,
    };
    const k = key[showWarnings || sort !== 'warnings' ? sort : 'activity'];
    items.sort((a, b) => {
      const av = k(a);
      const bv = k(b);
      if (av === bv) return a.displayName.localeCompare(b.displayName);
      return av < bv ? -dir : dir;
    });

    const pageSize = Math.min(Math.max(q.pageSize ?? 25, 1), 100);
    const page = Math.max(q.page ?? 1, 1);
    const total = items.length;
    items = items.slice((page - 1) * pageSize, page * pageSize);
    return { total, page, pageSize, items };
  }

  /** Roles with whether the actor (and the bot) can assign them. */
  roles(actor: Actor): RoleDto[] {
    const botTop = this.s.guild.botMember().highestRolePosition;
    return this.s.guild.listRoles().map((r) => ({
      id: r.id,
      name: r.name,
      color: r.color,
      position: r.position,
      managed: r.managed,
      assignable:
        !r.managed && r.position < botTop && (actor.isOwner || r.position < actor.highestRolePosition),
    }));
  }

  async memberDetail(actor: Actor, userId: string, now = Date.now()): Promise<MemberDetailResponse | null> {
    const { guild, activity, tiers, moderation, settings } = this.s;
    const live = await guild.getMember(userId);
    const row = this.s.members.get(userId);
    const user = live ? null : await guild.getUser(userId);
    if (!live && !row && !user) return null;

    const allRoles = new Map(this.roles(actor).map((r) => [r.id, r]));
    const roles = (live?.roleIds ?? [])
      .filter((r) => r !== guild.guildId)
      .map((r) => allRoles.get(r))
      .filter((r): r is RoleDto => Boolean(r))
      .sort((a, b) => b.position - a.position);

    const totals = activity.totals(userId, now);
    const board = activity.allTotals(now);
    const rankIndex = board.findIndex((b) => b.userId === userId);
    const progress = live ? tiers.progress(live, now) : null;
    const canCases = this.can(actor, 'admin:case');
    const canWarnings = this.can(actor, 'admin:warnings');
    const cases = canCases ? this.caseDtos(moderation.cases.list({ targetId: userId, limit: 100 })) : null;
    const joinedAt = row?.joinedAt ?? live?.joinedAt ?? null;

    return {
      userId,
      inGuild: Boolean(live),
      displayName: live?.displayName ?? row?.displayName ?? user?.username ?? userId,
      username: live?.username ?? row?.username ?? user?.username ?? userId,
      avatarUrl: live?.avatarUrl ?? row?.avatar ?? user?.avatarUrl ?? null,
      isBot: live?.isBot ?? row?.isBot ?? user?.isBot ?? false,
      nickname: live?.nickname ?? null,
      accountCreatedAt: (live?.createdAt ?? user?.createdAt)?.toISOString() ?? null,
      joinedAt: joinedAt?.toISOString() ?? null,
      firstJoinedAt: row?.firstJoinedAt.toISOString() ?? null,
      leftAt: row?.leftAt?.toISOString() ?? null,
      tenureDays: live && joinedAt ? tenureDays(joinedAt, now) : null,
      timedOutUntil: live?.communicationDisabledUntil?.toISOString() ?? null,
      roles,
      activity: {
        windowDays: settings.get().activity.windowDays,
        ...totals,
        rank: rankIndex >= 0 ? rankIndex + 1 : null,
        history: activity.history(userId, 90, now).map((h) => ({
          date: h.date,
          messagePoints: h.messagePoints,
          voiceMinutes: h.voiceMinutes,
        })),
      },
      tier: {
        current: progress?.current ? { name: progress.current.name, roleId: progress.current.roleId } : null,
        next: progress?.next
          ? {
              name: progress.next.tier.name,
              daysNeeded: progress.next.daysNeeded,
              pointsNeeded: progress.next.pointsNeeded,
            }
          : null,
      },
      cases,
      activeWarnings: canWarnings ? moderation.listWarnings(userId).length : null,
      can: {
        warn: this.can(actor, 'admin:warn'),
        timeout: this.can(actor, 'admin:timeout'),
        untimeout: this.can(actor, 'admin:untimeout'),
        kick: this.can(actor, 'admin:kick'),
        ban: this.can(actor, 'admin:ban'),
        role: this.can(actor, 'admin:role'),
      },
      mentions: this.mentions((cases ?? []).map((c) => c.reason)),
    };
  }

  /** Readable label for an audit row's target (role + node, tier, channel or member name). */
  auditTargetLabel(action: string, target: string | null, before: unknown, after: unknown): string | null {
    if (!target) return null;
    const obj = (v: unknown) => (typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {});
    if (action.startsWith('permissions.')) {
      const [roleId, ...rest] = target.split(':');
      return `${this.s.guild.roleName(roleId!)} ${rest.join(':')}`;
    }
    if (action.startsWith('tiers.')) {
      const name = obj(after).name ?? obj(before).name;
      return typeof name === 'string' ? `Tier ${name}` : null;
    }
    if (action.startsWith('voice.hub.')) {
      const c = this.s.guild.getChannel(target);
      return c ? `#${c.name}` : null;
    }
    if (action.startsWith('dashboard.member.') || action === 'dashboard.login') {
      return this.userRefs([target]).get(target)?.name ?? null;
    }
    if (action === 'dashboard.command') return `/${target}`;
    return null;
  }

  // ── Moderation & logs ────────────────────────────────────────────────────

  listCases(q: {
    action?: ModCase['action'];
    targetId?: string;
    moderatorId?: string;
    source?: ModCase['source'];
    before?: number;
    limit?: number;
  }): CaseListResponse {
    const limit = Math.min(Math.max(q.limit ?? 50, 1), 200);
    const where: SQL[] = [eq(modCases.guildId, this.s.guild.guildId)];
    if (q.action) where.push(eq(modCases.action, q.action));
    if (q.targetId) where.push(eq(modCases.targetId, q.targetId));
    if (q.moderatorId) where.push(eq(modCases.moderatorId, q.moderatorId));
    if (q.source) where.push(eq(modCases.source, q.source));
    if (q.before) where.push(lt(modCases.caseNumber, q.before));
    const rows = this.s.db
      .select()
      .from(modCases)
      .where(and(...where))
      .orderBy(desc(modCases.caseNumber))
      .limit(limit + 1)
      .all();
    const page = rows.slice(0, limit);
    const items = this.caseDtos(page);
    return {
      items,
      nextBefore: rows.length > limit ? page.at(-1)!.caseNumber : null,
      mentions: this.mentions(items.map((c) => c.reason)),
    };
  }

  listLogs(q: {
    type?: LogType;
    userId?: string;
    channelId?: string;
    search?: string;
    from?: Date;
    to?: Date;
    before?: number;
    limit?: number;
  }): LogListResponse {
    const limit = Math.min(Math.max(q.limit ?? 50, 1), 200);
    const where: SQL[] = [eq(logs.guildId, this.s.guild.guildId)];
    if (q.type && (LOG_TYPES as readonly string[]).includes(q.type)) where.push(eq(logs.type, q.type));
    if (q.userId) where.push(or(eq(logs.actorId, q.userId), eq(logs.targetId, q.userId))!);
    if (q.channelId) where.push(eq(logs.channelId, q.channelId));
    if (q.search) {
      // Escape LIKE wildcards so a search for "100%" matches literally.
      const pattern = `%${q.search.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
      where.push(sql`${logs.summary} LIKE ${pattern} ESCAPE '\\'`);
    }
    if (q.from) where.push(gte(logs.createdAt, q.from));
    if (q.to) where.push(lte(logs.createdAt, q.to));
    if (q.before) where.push(lt(logs.id, q.before));
    const rows = this.s.db
      .select()
      .from(logs)
      .where(and(...where))
      .orderBy(desc(logs.id))
      .limit(limit + 1)
      .all();
    const page = rows.slice(0, limit);
    return {
      items: page.map((r) => ({
        id: r.id,
        type: r.type,
        event: r.event,
        actorId: r.actorId,
        targetId: r.targetId,
        channelId: r.channelId,
        summary: r.summary,
        data: r.data ?? null,
        createdAt: r.createdAt.toISOString(),
      })),
      nextBefore: rows.length > limit ? page.at(-1)!.id : null,
      mentions: this.mentions(page.map((r) => r.summary)),
    };
  }
}
