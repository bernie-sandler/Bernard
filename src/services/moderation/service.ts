import { and, eq, isNull, lte } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { type ModAction, type ModSource, modCases, scheduledActions } from '../../db/schema.js';
import type {
  BotInfoPort,
  ChannelKindName,
  GuildPort,
  MemberInfo,
  ModerationPort,
} from '../../discord/ports.js';
import type { Logger } from '../../logger.js';
import { formatDuration } from '../../shared/commandOptions.js';
import type { ResultEmbed } from '../../shared/commandResult.js';
import type { CommandContext } from '../commands/types.js';
import { UserError } from '../errors.js';
import type { LogService } from '../logs.js';
import type { SettingsService } from '../settings.js';
import { ACTION_LABELS, CaseStore, caseEmbed, type ModCase, type NewCase, targetMention } from './cases.js';
import { planPurge } from './purge.js';

export const MAX_TIMEOUT_MS = 28 * 86_400_000;
export const MAX_TEMPBAN_MS = 365 * 86_400_000;
const MAX_UNBAN_ATTEMPTS = 5;

/** Who is performing a moderation action, and from where. */
export interface ModActor {
  userId: string;
  displayName: string;
  isOwner: boolean;
  highestRolePosition: number;
  source: ModSource;
}

export function modActorFrom(ctx: CommandContext): ModActor {
  return {
    userId: ctx.actor.userId,
    displayName: ctx.actor.displayName,
    isOwner: ctx.actor.isOwner,
    highestRolePosition: ctx.actor.highestRolePosition,
    source: ctx.source,
  };
}

export interface ModerationDeps {
  db: Db;
  guildId: string;
  guild: GuildPort;
  mod: ModerationPort;
  logs: LogService;
  settings: SettingsService;
  bot: BotInfoPort;
  logger: Logger;
}

const TEXT_KINDS: ChannelKindName[] = ['text', 'announcement', 'forum', 'voice', 'stage'];
const SENDABLE_KINDS: ChannelKindName[] = ['text', 'announcement', 'voice'];

/** All moderation logic. Slash commands, dashboard routes and event handlers call into this. */
export class ModerationService {
  readonly cases: CaseStore;

  constructor(private readonly d: ModerationDeps) {
    this.cases = new CaseStore(d.db, d.guildId);
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private async record(input: NewCase): Promise<ModCase> {
    const c = this.cases.create(input);
    const reason = c.reason ? `: ${c.reason}` : '';
    const by = c.source === 'system' ? 'the system' : `<@${c.moderatorId}>`;
    try {
      const { messageId } = await this.d.logs.record({
        type: 'moderation',
        event: `case_${c.action}`,
        actorId: c.source === 'system' ? null : c.moderatorId,
        targetId: c.targetId,
        summary: `Case #${c.caseNumber} ${ACTION_LABELS[c.action]} ${targetMention(c)} by ${by} (${c.source})${reason}`,
        data: { caseNumber: c.caseNumber, action: c.action, source: c.source, reason: c.reason },
        embed: caseEmbed(c),
      });
      this.cases.setLogMessage(c.id, messageId);
    } catch (err) {
      this.d.logger.error({ err, caseNumber: c.caseNumber }, 'Failed to log moderation case');
    }
    return c;
  }

  /** Reason shown in Discord's own audit log, so it names the real moderator. */
  private auditReason(actor: ModActor, reason?: string | null): string {
    const via = actor.source === 'dashboard' ? ' via dashboard' : '';
    return `${reason || 'No reason given'} (by ${actor.displayName} [${actor.userId}]${via})`.slice(0, 512);
  }

  private async requireMember(userId: string): Promise<MemberInfo> {
    const m = await this.d.guild.getMember(userId);
    if (!m) throw new UserError('That user is not a member of this server.');
    return m;
  }

  /** Self/owner/bot and role-hierarchy checks shared by member-targeted actions. */
  private assertCanModerate(
    actor: ModActor,
    targetId: string,
    member: MemberInfo | null,
    verb: string,
    opts: { allowSelf?: boolean } = {},
  ): void {
    const botId = this.d.bot.userId();
    if (!opts.allowSelf && targetId === actor.userId) throw new UserError(`You can't ${verb} yourself.`);
    if (targetId === botId) throw new UserError(`I can't ${verb} myself.`);
    if (targetId === this.d.guild.ownerId()) throw new UserError(`You can't ${verb} the server owner.`);
    if (!member) return;
    if (
      !actor.isOwner &&
      targetId !== actor.userId &&
      member.highestRolePosition >= actor.highestRolePosition
    ) {
      throw new UserError(`You can't ${verb} someone whose highest role is equal to or above yours.`);
    }
    if (member.highestRolePosition >= this.d.guild.botMember().highestRolePosition) {
      throw new UserError(
        `I can't ${verb} them: their highest role is equal to or above mine. Move my role higher in Server Settings → Roles.`,
      );
    }
  }

  /** Best-effort DM, only when enabled. Returns whether it was delivered. */
  private async notify(userId: string, text: string): Promise<boolean> {
    if (!this.d.settings.get().moderation.dmOnAction) return false;
    return this.d.mod.dm(userId, text);
  }

  private dmText(verb: string, reason?: string | null, extra = ''): string {
    const guild = this.d.guild.summary().name;
    return `You were ${verb} in **${guild}**${extra}.${reason ? `\nReason: ${reason}` : ''}`;
  }

  private assertChannel(channelId: string, kinds: ChannelKindName[], what: string) {
    const c = this.d.guild.getChannel(channelId);
    if (!c) throw new UserError('That channel does not exist.');
    if (!kinds.includes(c.kind)) throw new UserError(`You can't ${what} a ${c.kind} channel.`);
    return c;
  }

  // ── Member actions ───────────────────────────────────────────────────────

  async ban(
    actor: ModActor,
    input: { userId: string; reason?: string; durationMs?: number; deleteDays?: number },
  ): Promise<{ case: ModCase; dmed: boolean }> {
    const member = await this.d.guild.getMember(input.userId);
    this.assertCanModerate(actor, input.userId, member, 'ban');
    if (input.durationMs && input.durationMs > MAX_TEMPBAN_MS)
      throw new UserError('Temporary bans can last at most 365 days.');
    if (await this.d.mod.isBanned(input.userId)) throw new UserError('That user is already banned.');
    const extra = input.durationMs ? ` for ${formatDuration(input.durationMs)}` : '';
    const dmed = member ? await this.notify(input.userId, this.dmText('banned', input.reason, extra)) : false;
    await this.d.mod.ban(input.userId, {
      reason: this.auditReason(actor, input.reason),
      ...(input.deleteDays ? { deleteMessageSeconds: input.deleteDays * 86_400 } : {}),
    });
    const expiresAt = input.durationMs ? new Date(Date.now() + input.durationMs) : null;
    const c = await this.record({
      action: 'ban',
      targetId: input.userId,
      moderatorId: actor.userId,
      reason: input.reason ?? null,
      durationMs: input.durationMs ?? null,
      expiresAt,
      source: actor.source,
      data: input.deleteDays ? { deleteDays: input.deleteDays } : null,
    });
    if (expiresAt) {
      this.d.db
        .insert(scheduledActions)
        .values({
          guildId: this.d.guildId,
          kind: 'unban',
          targetId: input.userId,
          caseId: c.id,
          runAt: expiresAt,
        })
        .run();
    }
    return { case: c, dmed };
  }

  async unban(actor: ModActor, input: { userId: string; reason?: string }): Promise<ModCase> {
    if (!(await this.d.mod.isBanned(input.userId))) throw new UserError('That user is not banned.');
    await this.d.mod.unban(input.userId, this.auditReason(actor, input.reason));
    this.cancelPendingUnbans(input.userId);
    return this.record({
      action: 'unban',
      targetId: input.userId,
      moderatorId: actor.userId,
      reason: input.reason ?? null,
      source: actor.source,
    });
  }

  async kick(
    actor: ModActor,
    input: { userId: string; reason?: string },
  ): Promise<{ case: ModCase; dmed: boolean }> {
    const member = await this.requireMember(input.userId);
    this.assertCanModerate(actor, input.userId, member, 'kick');
    const dmed = await this.notify(input.userId, this.dmText('kicked', input.reason));
    await this.d.mod.kick(input.userId, this.auditReason(actor, input.reason));
    const c = await this.record({
      action: 'kick',
      targetId: input.userId,
      moderatorId: actor.userId,
      reason: input.reason ?? null,
      source: actor.source,
    });
    return { case: c, dmed };
  }

  async timeout(
    actor: ModActor,
    input: { userId: string; durationMs: number; reason?: string },
  ): Promise<{ case: ModCase; dmed: boolean }> {
    const member = await this.requireMember(input.userId);
    this.assertCanModerate(actor, input.userId, member, 'time out');
    if (member.isAdministrator)
      throw new UserError("Discord doesn't allow timing out members with Administrator.");
    if (input.durationMs > MAX_TIMEOUT_MS)
      throw new UserError('Timeouts can last at most 28 days (a Discord limit).');
    await this.d.mod.timeout(input.userId, input.durationMs, this.auditReason(actor, input.reason));
    const dmed = await this.notify(
      input.userId,
      this.dmText('timed out', input.reason, ` for ${formatDuration(input.durationMs)}`),
    );
    const c = await this.record({
      action: 'timeout',
      targetId: input.userId,
      moderatorId: actor.userId,
      reason: input.reason ?? null,
      durationMs: input.durationMs,
      expiresAt: new Date(Date.now() + input.durationMs),
      source: actor.source,
    });
    return { case: c, dmed };
  }

  async untimeout(actor: ModActor, input: { userId: string; reason?: string }): Promise<ModCase> {
    const member = await this.requireMember(input.userId);
    if (!member.communicationDisabledUntil) throw new UserError('That member is not timed out.');
    this.assertCanModerate(actor, input.userId, member, 'remove the timeout from');
    await this.d.mod.timeout(input.userId, null, this.auditReason(actor, input.reason));
    return this.record({
      action: 'untimeout',
      targetId: input.userId,
      moderatorId: actor.userId,
      reason: input.reason ?? null,
      source: actor.source,
    });
  }

  async warn(
    actor: ModActor,
    input: { userId: string; reason: string },
  ): Promise<{ case: ModCase; dmed: boolean; activeWarnings: number }> {
    const member = await this.requireMember(input.userId);
    this.assertCanModerate(actor, input.userId, member, 'warn');
    const c = await this.record({
      action: 'warn',
      targetId: input.userId,
      moderatorId: actor.userId,
      reason: input.reason,
      source: actor.source,
    });
    const dmed = await this.notify(input.userId, this.dmText('warned', input.reason));
    return { case: c, dmed, activeWarnings: this.listWarnings(input.userId).length };
  }

  listWarnings(userId: string): ModCase[] {
    return this.cases.list({ targetId: userId, action: 'warn', activeOnly: true, limit: 100 });
  }

  async removeWarning(actor: ModActor, caseNumber: number): Promise<ModCase> {
    const c = this.cases.get(caseNumber);
    if (!c || c.action !== 'warn') throw new UserError(`Case #${caseNumber} is not a warning.`);
    if (!c.active) throw new UserError(`Warning #${caseNumber} was already removed.`);
    this.cases.setActive(c.id, false);
    await this.d.logs.record({
      type: 'moderation',
      event: 'warning_removed',
      actorId: actor.userId,
      targetId: c.targetId,
      summary: `Warning #${caseNumber} for <@${c.targetId}> removed by <@${actor.userId}> (${actor.source})`,
      data: { caseNumber, source: actor.source },
    });
    return { ...c, active: false };
  }

  async setNickname(actor: ModActor, input: { userId: string; nickname?: string }): Promise<ModCase> {
    const member = await this.requireMember(input.userId);
    this.assertCanModerate(actor, input.userId, member, 'rename', { allowSelf: true });
    const before = member.nickname;
    const next = input.nickname?.trim() ? input.nickname.trim() : null;
    if (next && next.length > 32) throw new UserError('Nicknames can be at most 32 characters.');
    await this.d.mod.setNickname(input.userId, next, this.auditReason(actor));
    return this.record({
      action: 'nick',
      targetId: input.userId,
      moderatorId: actor.userId,
      source: actor.source,
      data: { before, after: next },
    });
  }

  async changeRole(
    actor: ModActor,
    input: { userId: string; roleId: string; add: boolean },
  ): Promise<ModCase> {
    if (input.roleId === this.d.guildId) {
      throw new UserError('Everyone has @everyone; it cannot be added or removed.');
    }
    const role = this.d.guild.getRole(input.roleId);
    if (!role) throw new UserError('That role does not exist.');
    if (role.managed)
      throw new UserError(`${role.name} is managed by an integration and can't be assigned manually.`);
    if (role.position >= this.d.guild.botMember().highestRolePosition) {
      throw new UserError(`${role.name} is at or above my highest role, so I can't manage it.`);
    }
    if (!actor.isOwner && role.position >= actor.highestRolePosition) {
      throw new UserError(`${role.name} is at or above your highest role, so you can't manage it.`);
    }
    const member = await this.requireMember(input.userId);
    const has = member.roleIds.includes(role.id);
    if (input.add && has) throw new UserError(`They already have ${role.name}.`);
    if (!input.add && !has) throw new UserError(`They don't have ${role.name}.`);
    if (input.add) await this.d.mod.addRole(input.userId, role.id, this.auditReason(actor));
    else await this.d.mod.removeRole(input.userId, role.id, this.auditReason(actor));
    return this.record({
      action: input.add ? 'role_add' : 'role_remove',
      targetId: input.userId,
      moderatorId: actor.userId,
      source: actor.source,
      data: { roleId: role.id, roleName: role.name },
    });
  }

  // ── Channel actions ──────────────────────────────────────────────────────

  async purge(
    actor: ModActor,
    input: { channelId: string; amount: number; userId?: string },
  ): Promise<{ case: ModCase; deleted: number; skippedOld: number; skippedPinned: number; scanned: number }> {
    this.assertChannel(input.channelId, TEXT_KINDS, 'purge');
    const maxScan = input.userId ? 500 : input.amount;
    const scanned: Awaited<ReturnType<ModerationPort['fetchMessages']>> = [];
    let before: string | undefined;
    while (scanned.length < maxScan) {
      const page = await this.d.mod.fetchMessages(
        input.channelId,
        Math.min(100, maxScan - scanned.length),
        before,
      );
      scanned.push(...page);
      if (page.length < 100) break;
      before = page[page.length - 1]!.id;
      if (input.userId && scanned.filter((m) => m.authorId === input.userId).length >= input.amount) break;
    }
    const plan = planPurge(scanned, {
      amount: input.amount,
      ...(input.userId ? { userId: input.userId } : {}),
    });
    const deleted = await this.d.mod.deleteMessages(input.channelId, plan.toDelete);
    const c = await this.record({
      action: 'purge',
      targetId: input.userId ?? input.channelId,
      moderatorId: actor.userId,
      source: actor.source,
      data: {
        targetType: input.userId ? 'user' : 'channel',
        channelId: input.channelId,
        deleted,
        skippedOld: plan.skippedOld,
        skippedPinned: plan.skippedPinned,
        scanned: plan.scanned,
      },
    });
    return {
      case: c,
      deleted,
      skippedOld: plan.skippedOld,
      skippedPinned: plan.skippedPinned,
      scanned: plan.scanned,
    };
  }

  async slowmode(actor: ModActor, input: { channelId: string; seconds: number }): Promise<ModCase> {
    this.assertChannel(
      input.channelId,
      ['text', 'announcement', 'forum', 'voice', 'stage'],
      'set slowmode on',
    );
    await this.d.mod.setSlowmode(input.channelId, input.seconds, this.auditReason(actor));
    return this.record({
      action: 'slowmode',
      targetId: input.channelId,
      moderatorId: actor.userId,
      source: actor.source,
      data: { seconds: input.seconds },
    });
  }

  async lock(actor: ModActor, input: { channelId: string; reason?: string }): Promise<ModCase> {
    this.assertChannel(input.channelId, ['text', 'announcement', 'forum', 'voice'], 'lock');
    const existing = this.cases.latest('lock', input.channelId);
    if (existing?.active) throw new UserError('That channel is already locked. Use /unlock first.');
    const previous = await this.d.mod.setLocked(
      input.channelId,
      true,
      undefined,
      this.auditReason(actor, input.reason),
    );
    return this.record({
      action: 'lock',
      targetId: input.channelId,
      moderatorId: actor.userId,
      reason: input.reason ?? null,
      source: actor.source,
      data: { previous },
    });
  }

  async unlock(actor: ModActor, input: { channelId: string; reason?: string }): Promise<ModCase> {
    this.assertChannel(input.channelId, ['text', 'announcement', 'forum', 'voice'], 'unlock');
    const lockCase = this.cases.latest('lock', input.channelId);
    const previous =
      lockCase?.active && lockCase.data?.previous
        ? (lockCase.data.previous as Record<string, boolean | null>)
        : undefined;
    await this.d.mod.setLocked(input.channelId, false, previous, this.auditReason(actor, input.reason));
    if (lockCase?.active) this.cases.setActive(lockCase.id, false);
    return this.record({
      action: 'unlock',
      targetId: input.channelId,
      moderatorId: actor.userId,
      reason: input.reason ?? null,
      source: actor.source,
      data: { restored: previous ?? 'inherit' },
    });
  }

  async announce(
    _actor: ModActor,
    input: { channelId: string; message: string; asEmbed?: boolean; title?: string; color?: number },
  ): Promise<{ messageId: string }> {
    this.assertChannel(input.channelId, SENDABLE_KINDS, 'announce in');
    const message = input.message.replace(/\\n/g, '\n');
    if (input.asEmbed) {
      if (message.length > 4096) throw new UserError('Embed announcements can be at most 4096 characters.');
      const embed: ResultEmbed = { description: message, color: input.color ?? 0x5865f2 };
      if (input.title) embed.title = input.title;
      return { messageId: await this.d.mod.sendMessage(input.channelId, { embed }) };
    }
    if (message.length > 2000)
      throw new UserError('Plain announcements can be at most 2000 characters (use embed:true for longer).');
    const content = input.title ? `**${input.title}**\n${message}` : message;
    if (content.length > 2000) throw new UserError('Title plus message exceed 2000 characters.');
    return { messageId: await this.d.mod.sendMessage(input.channelId, { content }) };
  }

  // ── External (native Discord) actions ────────────────────────────────────

  /** Record a ban/kick/timeout done through Discord's own UI (seen via the audit log). */
  async recordExternal(input: {
    action: Extract<ModAction, 'ban' | 'unban' | 'kick' | 'timeout' | 'untimeout'>;
    targetId: string;
    moderatorId: string;
    reason: string | null;
    durationMs?: number | null;
  }): Promise<ModCase> {
    if (input.action === 'unban') this.cancelPendingUnbans(input.targetId);
    return this.record({
      action: input.action,
      targetId: input.targetId,
      moderatorId: input.moderatorId,
      reason: input.reason,
      durationMs: input.durationMs ?? null,
      expiresAt: input.durationMs ? new Date(Date.now() + input.durationMs) : null,
      source: 'discord',
    });
  }

  // ── Scheduled unbans ─────────────────────────────────────────────────────

  cancelPendingUnbans(userId: string): number {
    return this.d.db
      .update(scheduledActions)
      .set({ doneAt: new Date(), lastError: 'cancelled' })
      .where(
        and(
          eq(scheduledActions.guildId, this.d.guildId),
          eq(scheduledActions.kind, 'unban'),
          eq(scheduledActions.targetId, userId),
          isNull(scheduledActions.doneAt),
        ),
      )
      .run().changes;
  }

  /** Lift temporary bans whose time is up. Returns how many were processed. */
  async processDueUnbans(now = new Date()): Promise<number> {
    const due = this.d.db
      .select()
      .from(scheduledActions)
      .where(
        and(
          eq(scheduledActions.guildId, this.d.guildId),
          eq(scheduledActions.kind, 'unban'),
          isNull(scheduledActions.doneAt),
          lte(scheduledActions.runAt, now),
        ),
      )
      .all();
    for (const a of due) {
      try {
        if (await this.d.mod.isBanned(a.targetId)) {
          await this.d.mod.unban(a.targetId, 'Temporary ban expired');
          const original = a.caseId
            ? this.d.db.select().from(modCases).where(eq(modCases.id, a.caseId)).get()
            : undefined;
          await this.record({
            action: 'unban',
            targetId: a.targetId,
            moderatorId: this.d.bot.userId() ?? 'system',
            reason: original
              ? `Temporary ban expired (case #${original.caseNumber})`
              : 'Temporary ban expired',
            source: 'system',
          });
        }
        this.d.db
          .update(scheduledActions)
          .set({ doneAt: new Date() })
          .where(eq(scheduledActions.id, a.id))
          .run();
      } catch (err) {
        const attempts = a.attempts + 1;
        this.d.logger.warn({ err, targetId: a.targetId, attempts }, 'Scheduled unban failed');
        this.d.db
          .update(scheduledActions)
          .set({
            attempts,
            lastError: err instanceof Error ? err.message : String(err),
            ...(attempts >= MAX_UNBAN_ATTEMPTS ? { doneAt: new Date() } : {}),
          })
          .where(eq(scheduledActions.id, a.id))
          .run();
      }
    }
    return due.length;
  }
}
