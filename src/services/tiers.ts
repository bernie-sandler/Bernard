import { and, asc, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { memberTierState, tiers } from '../db/schema.js';
import type { GuildPort, MemberInfo, ModerationPort } from '../discord/ports.js';
import type { Logger } from '../logger.js';
import type { ActivityService } from './activity.js';
import type { AuditActor, AuditService } from './audit.js';
import type { BotStateStore } from './botState.js';
import { UserError } from './errors.js';
import type { EventLogService } from './eventLog.js';
import { DAY_MS, type MemberService, tenureDays } from './members.js';
import type { SettingsService } from './settings.js';

export const MAX_TIERS = 10;
const EVALUATE_DEBOUNCE_MS = 5_000;

export type TierRow = typeof tiers.$inferSelect;
export type TierDef = Pick<TierRow, 'id' | 'name' | 'roleId' | 'minTenureDays' | 'minActivity' | 'position'>;

export function qualifies(
  t: Pick<TierDef, 'minTenureDays' | 'minActivity'>,
  tenure: number,
  score: number,
): boolean {
  return tenure >= t.minTenureDays && score >= t.minActivity;
}

export interface PlanInput {
  tiers: TierDef[];
  roleIds: readonly string[];
  tenureDays: number;
  score: number;
  /** tierId → when the member first fell below that tier (only for tiers they hold). */
  belowSince: ReadonlyMap<number, Date>;
  mode: 'highest_only' | 'stack';
  demotion: boolean;
  graceDays: number;
  now: Date;
}

export interface PlanOutput {
  add: string[];
  remove: string[];
  /** Tiers the member should hold afterwards. */
  target: TierDef[];
  belowSince: Map<number, Date>;
}

/**
 * Decide which tier roles a member should gain or lose.
 * - A tier is earned when both thresholds are met.
 * - A held tier the member no longer qualifies for is kept when demotion is off, or while the
 *   demotion grace period runs; afterwards it is removed.
 * - highest_only keeps only the highest earned tier; stack keeps all of them.
 */
export function planTiers(input: PlanInput): PlanOutput {
  const sorted = [...input.tiers].sort((a, b) => a.position - b.position);
  const effective: TierDef[] = [];
  const belowSince = new Map<number, Date>();
  for (const t of sorted) {
    const held = input.roleIds.includes(t.roleId);
    if (qualifies(t, input.tenureDays, input.score)) {
      effective.push(t);
    } else if (held) {
      if (!input.demotion) {
        effective.push(t);
        continue;
      }
      const since = input.belowSince.get(t.id) ?? input.now;
      if (input.now.getTime() - since.getTime() < input.graceDays * DAY_MS) {
        effective.push(t);
        belowSince.set(t.id, since);
      }
    }
  }
  const target = input.mode === 'stack' ? effective : effective.slice(-1);
  const targetRoles = new Set(target.map((t) => t.roleId));
  const add = target.filter((t) => !input.roleIds.includes(t.roleId)).map((t) => t.roleId);
  const remove = sorted
    .filter((t) => input.roleIds.includes(t.roleId) && !targetRoles.has(t.roleId))
    .map((t) => t.roleId);
  return { add, remove, target, belowSince };
}

export interface TierCheck {
  ok: boolean;
  issues: string[];
  tiers: { tier: TierRow; members: number; manageable: boolean; problem: string | null }[];
}

export interface SyncSummary {
  at: string;
  reason: string;
  members: number;
  changed: number;
  skipped: number;
  errors: number;
  durationMs: number;
}

export interface TierDeps {
  db: Db;
  guildId: string;
  guild: GuildPort;
  mod: ModerationPort;
  settings: SettingsService;
  audit: AuditService;
  eventLog: EventLogService;
  activity: ActivityService;
  members: MemberService;
  state: BotStateStore;
  logger: Logger;
  now?: () => number;
}

export class TierService {
  private readonly pending = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private syncing = false;
  private readonly now: () => number;

  constructor(private readonly d: TierDeps) {
    this.now = d.now ?? Date.now;
  }

  // ── Configuration ────────────────────────────────────────────────────────

  list(): TierRow[] {
    return this.d.db
      .select()
      .from(tiers)
      .where(eq(tiers.guildId, this.d.guildId))
      .orderBy(asc(tiers.position))
      .all();
  }

  get(id: number): TierRow | undefined {
    return this.list().find((t) => t.id === id);
  }

  /** Find a tier by id, name (case-insensitive) or role id. */
  find(ref: string): TierRow | undefined {
    const all = this.list();
    const r = ref.trim();
    return (
      all.find((t) => String(t.id) === r) ??
      all.find((t) => t.name.toLowerCase() === r.toLowerCase()) ??
      all.find((t) => t.roleId === r)
    );
  }

  private validate(
    input: { name?: string; roleId?: string; minTenureDays?: number; minActivity?: number },
    selfId?: number,
  ) {
    if (input.name !== undefined) {
      const n = input.name.trim();
      if (!n || n.length > 50) throw new UserError('Tier names must be 1-50 characters.');
      if (this.list().some((t) => t.id !== selfId && t.name.toLowerCase() === n.toLowerCase())) {
        throw new UserError(`A tier named "${n}" already exists.`);
      }
    }
    if (input.roleId !== undefined) {
      if (input.roleId === this.d.guildId) throw new UserError('@everyone cannot be a tier role.');
      const role = this.d.guild.getRole(input.roleId);
      if (!role) throw new UserError('That role does not exist.');
      if (role.managed)
        throw new UserError(`${role.name} is managed by an integration and can't be a tier role.`);
      if (this.list().some((t) => t.id !== selfId && t.roleId === input.roleId)) {
        throw new UserError(`${role.name} is already used by another tier.`);
      }
    }
    if (
      input.minTenureDays !== undefined &&
      (!Number.isInteger(input.minTenureDays) || input.minTenureDays < 0)
    ) {
      throw new UserError('Minimum tenure must be a whole number of days, 0 or more.');
    }
    if (input.minActivity !== undefined && (!Number.isFinite(input.minActivity) || input.minActivity < 0)) {
      throw new UserError('Minimum activity must be 0 or more.');
    }
  }

  add(
    actor: AuditActor,
    input: { name: string; roleId: string; minTenureDays: number; minActivity: number; position?: number },
  ): TierRow {
    const current = this.list();
    if (current.length >= MAX_TIERS) throw new UserError(`You can have at most ${MAX_TIERS} tiers.`);
    this.validate(input);
    const row = this.d.db
      .insert(tiers)
      .values({
        guildId: this.d.guildId,
        name: input.name.trim(),
        roleId: input.roleId,
        minTenureDays: input.minTenureDays,
        minActivity: input.minActivity,
        position: current.length + 1,
        createdAt: new Date(this.now()),
      })
      .returning()
      .get();
    if (input.position !== undefined) this.move(row.id, input.position);
    const saved = this.get(row.id)!;
    this.d.audit.record(actor, { action: 'tiers.add', target: String(saved.id), before: null, after: saved });
    return saved;
  }

  edit(
    actor: AuditActor,
    id: number,
    patch: {
      name?: string;
      roleId?: string;
      minTenureDays?: number;
      minActivity?: number;
      position?: number;
    },
  ): TierRow {
    const before = this.get(id);
    if (!before) throw new UserError('That tier does not exist.');
    this.validate(patch, id);
    const { position, ...fields } = patch;
    if (Object.keys(fields).length) {
      this.d.db
        .update(tiers)
        .set({ ...fields, ...(fields.name ? { name: fields.name.trim() } : {}) })
        .where(eq(tiers.id, id))
        .run();
    }
    if (position !== undefined) this.move(id, position);
    const after = this.get(id)!;
    this.d.audit.record(actor, { action: 'tiers.edit', target: String(id), before, after });
    return after;
  }

  remove(actor: AuditActor, id: number): TierRow {
    const before = this.get(id);
    if (!before) throw new UserError('That tier does not exist.');
    this.d.db.delete(tiers).where(eq(tiers.id, id)).run();
    this.renumber(this.list().map((t) => t.id));
    this.d.audit.record(actor, { action: 'tiers.remove', target: String(id), before, after: null });
    return before;
  }

  /** Set the full order, lowest tier first. */
  reorder(actor: AuditActor, ids: number[]): TierRow[] {
    const before = this.list();
    const current = before.map((t) => t.id).sort();
    if (ids.length !== current.length || [...ids].sort().some((v, i) => v !== current[i])) {
      throw new UserError('The new order must list every tier exactly once.');
    }
    this.renumber(ids);
    const after = this.list();
    this.d.audit.record(actor, {
      action: 'tiers.reorder',
      target: null,
      before: before.map((t) => t.id),
      after: after.map((t) => t.id),
    });
    return after;
  }

  private move(id: number, position: number): void {
    const ids = this.list()
      .map((t) => t.id)
      .filter((x) => x !== id);
    const index = Math.max(0, Math.min(ids.length, Math.round(position) - 1));
    ids.splice(index, 0, id);
    this.renumber(ids);
  }

  private renumber(ids: number[]): void {
    this.d.db.transaction(() => {
      ids.forEach((id, i) => {
        this.d.db
          .update(tiers)
          .set({ position: i + 1 })
          .where(eq(tiers.id, id))
          .run();
      });
    });
  }

  /** Validate the configuration and role hierarchy. */
  check(): TierCheck {
    const botTop = this.d.guild.botMember().highestRolePosition;
    const issues: string[] = [];
    const list = this.list();
    const rows = list.map((tier) => {
      const role = this.d.guild.getRole(tier.roleId);
      let problem: string | null = null;
      if (!role) problem = 'role no longer exists';
      else if (role.managed) problem = 'role is managed by an integration';
      else if (role.position >= botTop) problem = "role is at or above the bot's highest role";
      if (problem) issues.push(`**${tier.name}**: ${problem}.`);
      return {
        tier,
        members: role ? this.d.guild.roleMemberCount(tier.roleId) : 0,
        manageable: !problem,
        problem,
      };
    });
    if (rows.some((r) => r.problem?.includes('above'))) {
      issues.push("Move the bot's role above every tier role in Server Settings → Roles.");
    }
    for (let i = 1; i < list.length; i++) {
      const lower = list[i - 1]!;
      const higher = list[i]!;
      if (higher.minTenureDays <= lower.minTenureDays && higher.minActivity <= lower.minActivity) {
        issues.push(
          `**${higher.name}** is no harder to reach than **${lower.name}** below it; check the order.`,
        );
      }
    }
    return { ok: issues.length === 0, issues, tiers: rows };
  }

  // ── Evaluation ───────────────────────────────────────────────────────────

  private loadBelowSince(userId: string): Map<number, Date> {
    const rows = this.d.db
      .select()
      .from(memberTierState)
      .where(and(eq(memberTierState.guildId, this.d.guildId), eq(memberTierState.userId, userId)))
      .all();
    return new Map(rows.filter((r) => r.belowSince).map((r) => [r.tierId, r.belowSince!]));
  }

  private saveBelowSince(userId: string, map: Map<number, Date>): void {
    this.d.db.transaction(() => {
      this.d.db
        .delete(memberTierState)
        .where(and(eq(memberTierState.guildId, this.d.guildId), eq(memberTierState.userId, userId)))
        .run();
      for (const [tierId, since] of map) {
        this.d.db
          .insert(memberTierState)
          .values({ guildId: this.d.guildId, userId, tierId, belowSince: since })
          .run();
      }
    });
  }

  private isExcluded(member: MemberInfo): boolean {
    if (member.isBot) return true;
    const excluded = this.d.settings.get().tiers.excludedRoleIds;
    return member.roleIds.some((r) => excluded.includes(r));
  }

  /**
   * Evaluate one member and apply role changes. Roles the bot can't manage are skipped.
   * Returns the role changes actually made.
   */
  async evaluateMember(
    member: MemberInfo,
    opts: { score?: number; reason?: string; manageable?: Set<string> } = {},
  ): Promise<{ added: string[]; removed: string[]; skipped: number }> {
    const list = this.list();
    if (list.length === 0 || this.isExcluded(member)) return { added: [], removed: [], skipped: 0 };
    const s = this.d.settings.get().tiers;
    const now = new Date(this.now());
    const row = this.d.members.get(member.userId);
    const joinedAt = row?.joinedAt ?? member.joinedAt ?? now;
    const plan = planTiers({
      tiers: list,
      roleIds: member.roleIds,
      tenureDays: tenureDays(joinedAt, now.getTime()),
      score: opts.score ?? this.d.activity.totals(member.userId).score,
      belowSince: this.loadBelowSince(member.userId),
      mode: s.mode,
      demotion: s.demotion,
      graceDays: s.demotionGraceDays,
      now,
    });
    this.saveBelowSince(member.userId, plan.belowSince);

    const manageable =
      opts.manageable ??
      new Set(
        this.check()
          .tiers.filter((t) => t.manageable)
          .map((t) => t.tier.roleId),
      );
    const add = plan.add.filter((r) => manageable.has(r));
    const remove = plan.remove.filter((r) => manageable.has(r));
    const skipped = plan.add.length + plan.remove.length - add.length - remove.length;
    // Add before removing so a promoted member is never briefly without a tier role.
    for (const r of add) await this.d.mod.addRole(member.userId, r, 'Tier sync');
    for (const r of remove) await this.d.mod.removeRole(member.userId, r, 'Tier sync');
    if (add.length || remove.length) {
      await this.d.eventLog.tierChanged({
        userId: member.userId,
        added: add,
        removed: remove,
        reason: opts.reason ?? 'tier evaluation',
      });
    }
    return { added: add, removed: remove, skipped };
  }

  /** Re-evaluate every member now. */
  async syncAll(reason: string): Promise<SyncSummary> {
    if (this.syncing) throw new UserError('A tier sync is already running.');
    this.syncing = true;
    const started = this.now();
    let changed = 0;
    let skipped = 0;
    let errors = 0;
    let count = 0;
    try {
      const memberList = await this.d.guild.listMembers();
      const scores = new Map(this.d.activity.allTotals().map((t) => [t.userId, t.score]));
      const manageable = new Set(
        this.check()
          .tiers.filter((t) => t.manageable)
          .map((t) => t.tier.roleId),
      );
      for (const m of memberList) {
        count++;
        try {
          const r = await this.evaluateMember(m, { score: scores.get(m.userId) ?? 0, reason, manageable });
          if (r.added.length || r.removed.length) changed++;
          skipped += r.skipped;
        } catch (err) {
          errors++;
          this.d.logger.warn({ err, userId: m.userId }, 'Tier evaluation failed');
        }
      }
    } finally {
      this.syncing = false;
    }
    const summary: SyncSummary = {
      at: new Date(this.now()).toISOString(),
      reason,
      members: count,
      changed,
      skipped,
      errors,
      durationMs: this.now() - started,
    };
    this.d.state.set('last_tier_sync', JSON.stringify(summary));
    this.d.logger.info(summary, 'Tier sync finished');
    return summary;
  }

  lastSync(): SyncSummary | null {
    const raw = this.d.state.get('last_tier_sync');
    if (!raw) return null;
    try {
      return JSON.parse(raw) as SyncSummary;
    } catch {
      return null;
    }
  }

  /** Called every minute; runs a full sync when the configured interval has passed. */
  async maybeScheduledSync(): Promise<SyncSummary | null> {
    if (this.syncing || this.list().length === 0) return null;
    const last = this.lastSync();
    const intervalMs = this.d.settings.get().tiers.syncIntervalMinutes * 60_000;
    if (last && this.now() - Date.parse(last.at) < intervalMs) return null;
    return this.syncAll('scheduled');
  }

  /** Evaluate a member soon (debounced), e.g. after their activity crossed a threshold or they joined. */
  queueEvaluate(userId: string): void {
    this.pending.add(userId);
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flushPending();
    }, EVALUATE_DEBOUNCE_MS);
    this.timer.unref?.();
  }

  async flushPending(): Promise<void> {
    const ids = [...this.pending];
    this.pending.clear();
    for (const id of ids) {
      try {
        const m = await this.d.guild.getMember(id);
        if (m) await this.evaluateMember(m, { reason: 'activity threshold reached' });
      } catch (err) {
        this.d.logger.warn({ err, userId: id }, 'Queued tier evaluation failed');
      }
    }
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Progress information for /rank and the dashboard. */
  progress(member: Pick<MemberInfo, 'userId' | 'roleIds' | 'joinedAt'>, now = this.now()) {
    const list = this.list();
    const row = this.d.members.get(member.userId);
    const joinedAt = row?.joinedAt ?? member.joinedAt ?? new Date(now);
    const tenure = tenureDays(joinedAt, now);
    const totals = this.d.activity.totals(member.userId, now);
    const held = list.filter((t) => member.roleIds.includes(t.roleId));
    const current = held.at(-1) ?? null;
    const topQualified = list.filter((t) => qualifies(t, tenure, totals.score)).at(-1);
    const floor = Math.max(current?.position ?? 0, topQualified?.position ?? 0);
    const next = list.find((t) => t.position > floor) ?? null;
    return {
      tenureDays: tenure,
      joinedAt,
      firstJoinedAt: row?.firstJoinedAt ?? joinedAt,
      totals,
      current,
      held,
      next: next
        ? {
            tier: next,
            daysNeeded: Math.max(0, next.minTenureDays - tenure),
            pointsNeeded: Math.max(0, next.minActivity - totals.score),
          }
        : null,
    };
  }
}
