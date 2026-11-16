import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { tempChannels, voiceHubs } from '../db/schema.js';
import type { GuildPort, VoicePort } from '../discord/ports.js';
import type { Logger } from '../logger.js';
import type { AuditActor, AuditService } from './audit.js';
import { UserError } from './errors.js';
import type { LiveEvents } from './liveEvents.js';
import type { SettingsService } from './settings.js';

export type Hub = typeof voiceHubs.$inferSelect;
export type TempChannel = typeof tempChannels.$inferSelect;

/** Discord allows roughly 2 name changes per channel per 10 minutes. */
export const RENAME_WINDOW_MS = 10 * 60_000;
export const RENAME_LIMIT = 2;
/** How long a deleted temp channel still counts as "managed" (so late gateway events stay quiet). */
const RECENTLY_DELETED_MS = 60_000;

export const DEFAULT_NAME_TEMPLATE = "{user}'s Channel";

/** Fill a hub's name template. Supports {user}, {username} and {count}. */
export function renderChannelName(
  template: string,
  vars: { user: string; username: string; count: number },
): string {
  const name = template
    .replaceAll('{user}', vars.user)
    .replaceAll('{username}', vars.username)
    .replaceAll('{count}', String(vars.count))
    .replace(/\s+/g, ' ')
    .trim();
  return (name || 'Voice Channel').slice(0, 100);
}

/** Milliseconds until another rename is allowed (0 = allowed now). */
export function renameWaitMs(timestamps: readonly number[], now: number): number {
  const recent = timestamps.filter((t) => now - t < RENAME_WINDOW_MS).sort((a, b) => a - b);
  if (recent.length < RENAME_LIMIT) return 0;
  return recent[recent.length - RENAME_LIMIT]! + RENAME_WINDOW_MS - now;
}

export interface VoiceStateChange {
  userId: string;
  displayName: string;
  username: string;
  isBot: boolean;
  from: string | null;
  to: string | null;
}

export interface VoiceDeps {
  db: Db;
  guildId: string;
  voice: VoicePort;
  guild: GuildPort;
  settings: SettingsService;
  audit: AuditService;
  logger: Logger;
  live?: LiveEvents;
  now?: () => number;
}

/** Join-to-create voice channels: hubs, temp channel lifecycle, ownership and owner commands. */
export class VoiceService {
  private readonly graceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly cooldowns = new Map<string, number>();
  private readonly busyUsers = new Set<string>();
  private readonly recentlyDeleted = new Map<string, number>();
  private readonly now: () => number;

  constructor(private readonly d: VoiceDeps) {
    this.now = d.now ?? Date.now;
  }

  // ── Queries ──────────────────────────────────────────────────────────────

  listHubs(): Hub[] {
    return this.d.db.select().from(voiceHubs).where(eq(voiceHubs.guildId, this.d.guildId)).all();
  }

  getHub(channelId: string): Hub | undefined {
    return this.d.db
      .select()
      .from(voiceHubs)
      .where(and(eq(voiceHubs.guildId, this.d.guildId), eq(voiceHubs.channelId, channelId)))
      .get();
  }

  listTemps(): TempChannel[] {
    return this.d.db.select().from(tempChannels).where(eq(tempChannels.guildId, this.d.guildId)).all();
  }

  getTemp(channelId: string): TempChannel | undefined {
    return this.d.db
      .select()
      .from(tempChannels)
      .where(and(eq(tempChannels.guildId, this.d.guildId), eq(tempChannels.channelId, channelId)))
      .get();
  }

  isTempChannel(channelId: string): boolean {
    return this.getTemp(channelId) !== undefined;
  }

  /** Temp channels (and ones deleted in the last minute) are excluded from the server log. */
  isManagedChannel(channelId: string): boolean {
    const deletedAt = this.recentlyDeleted.get(channelId);
    if (deletedAt !== undefined && this.now() - deletedAt < RECENTLY_DELETED_MS) return true;
    return this.isTempChannel(channelId);
  }

  /** Active temp channels with their current occupants (dashboard overview). */
  activeChannels(): { channelId: string; hubChannelId: string; ownerId: string | null; members: string[] }[] {
    return this.listTemps().map((t) => ({
      channelId: t.channelId,
      hubChannelId: t.hubChannelId,
      ownerId: t.ownerId,
      members: this.d.voice.channelMembers(t.channelId),
    }));
  }

  /** Voice states for activity tracking. */
  activitySnapshot() {
    return { channels: this.d.voice.snapshot(), afkChannelId: this.d.voice.afkChannelId() };
  }

  // ── Hub configuration ────────────────────────────────────────────────────

  addHub(
    actor: AuditActor,
    input: {
      channelId: string;
      type: 'public' | 'private';
      categoryId: string;
      nameTemplate?: string;
      defaultLimit?: number;
      hideFromEveryone?: boolean;
    },
  ): Hub {
    const channel = this.d.guild.getChannel(input.channelId);
    if (!channel || channel.kind !== 'voice') throw new UserError('The hub must be a voice channel.');
    this.assertCategory(input.categoryId);
    if (this.getHub(input.channelId))
      throw new UserError('That channel is already a hub. Use /voice hub edit.');
    if (this.isTempChannel(input.channelId)) throw new UserError('A temporary channel cannot be a hub.');
    const template = this.validTemplate(input.nameTemplate ?? DEFAULT_NAME_TEMPLATE);
    const hub = this.d.db
      .insert(voiceHubs)
      .values({
        channelId: input.channelId,
        guildId: this.d.guildId,
        type: input.type,
        categoryId: input.categoryId,
        nameTemplate: template,
        defaultLimit: this.validLimit(input.defaultLimit ?? 0),
        hideFromEveryone: input.type === 'private' && Boolean(input.hideFromEveryone),
        createdAt: new Date(this.now()),
      })
      .returning()
      .get();
    this.d.audit.record(actor, { action: 'voice.hub.add', target: hub.channelId, before: null, after: hub });
    return hub;
  }

  editHub(
    actor: AuditActor,
    channelId: string,
    patch: Partial<Pick<Hub, 'type' | 'categoryId' | 'nameTemplate' | 'defaultLimit' | 'hideFromEveryone'>>,
  ): Hub {
    const before = this.getHub(channelId);
    if (!before) throw new UserError('That channel is not a hub.');
    if (patch.categoryId) this.assertCategory(patch.categoryId);
    const type = patch.type ?? before.type;
    const next = {
      type,
      categoryId: patch.categoryId ?? before.categoryId,
      nameTemplate:
        patch.nameTemplate !== undefined ? this.validTemplate(patch.nameTemplate) : before.nameTemplate,
      defaultLimit:
        patch.defaultLimit !== undefined ? this.validLimit(patch.defaultLimit) : before.defaultLimit,
      hideFromEveryone: type === 'private' && (patch.hideFromEveryone ?? before.hideFromEveryone),
    };
    const after = this.d.db
      .update(voiceHubs)
      .set(next)
      .where(and(eq(voiceHubs.guildId, this.d.guildId), eq(voiceHubs.channelId, channelId)))
      .returning()
      .get();
    this.d.audit.record(actor, { action: 'voice.hub.edit', target: channelId, before, after });
    return after;
  }

  removeHub(actor: AuditActor, channelId: string): Hub {
    const hub = this.getHub(channelId);
    if (!hub) throw new UserError('That channel is not a hub.');
    this.d.db
      .delete(voiceHubs)
      .where(and(eq(voiceHubs.guildId, this.d.guildId), eq(voiceHubs.channelId, channelId)))
      .run();
    this.d.audit.record(actor, { action: 'voice.hub.remove', target: channelId, before: hub, after: null });
    return hub;
  }

  private assertCategory(categoryId: string): void {
    const c = this.d.guild.getChannel(categoryId);
    if (!c || c.kind !== 'category') throw new UserError('The category option must be a category.');
  }

  private validTemplate(t: string): string {
    const trimmed = t.trim();
    if (!trimmed || trimmed.length > 100) throw new UserError('Name templates must be 1-100 characters.');
    return trimmed;
  }

  private validLimit(n: number): number {
    if (!Number.isInteger(n) || n < 0 || n > 99)
      throw new UserError('User limits must be 0 (unlimited) to 99.');
    return n;
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  async handleVoiceStateUpdate(e: VoiceStateChange): Promise<void> {
    if (e.from === e.to) return;
    if (e.from && this.isTempChannel(e.from)) await this.onLeave(e.from, e.userId);
    if (!e.to) return;
    const hub = this.getHub(e.to);
    if (hub) {
      if (!e.isBot) await this.onHubJoin(hub, e);
    } else if (!e.isBot && this.isTempChannel(e.to)) {
      this.onJoin(e.to, e.userId);
    }
  }

  private async onHubJoin(
    hub: Hub,
    e: Pick<VoiceStateChange, 'userId' | 'displayName' | 'username'>,
  ): Promise<void> {
    const { voice, logger } = this.d;
    if (this.busyUsers.has(e.userId)) return;
    this.busyUsers.add(e.userId);
    try {
      // Someone who already owns a live channel goes back to it instead of creating another.
      const owned = this.listTemps().find((t) => t.ownerId === e.userId && voice.channelExists(t.channelId));
      if (owned) {
        await voice
          .moveMember(e.userId, owned.channelId)
          .catch((err) => logger.warn({ err }, 'Move to owned channel failed'));
        return;
      }

      const now = this.now();
      const cooldownMs = this.d.settings.get().voice.hubCooldownSeconds * 1000;
      const last = this.cooldowns.get(e.userId);
      if (cooldownMs > 0 && last !== undefined && now - last < cooldownMs) {
        const wait = Math.ceil((cooldownMs - (now - last)) / 1000);
        await voice.moveMember(e.userId, null).catch(() => {});
        await voice
          .notify(
            hub.channelId,
            `<@${e.userId}>, please wait ${wait}s before creating another channel.`,
            10_000,
          )
          .catch(() => {});
        return;
      }
      this.cooldowns.set(e.userId, now);

      const count = this.listTemps().filter((t) => t.hubChannelId === hub.channelId).length + 1;
      const name = renderChannelName(hub.nameTemplate, { user: e.displayName, username: e.username, count });
      let channelId: string;
      try {
        channelId = await voice.createVoiceChannel({
          name,
          categoryId: hub.categoryId,
          userLimit: hub.defaultLimit,
          ownerId: e.userId,
          denyEveryoneConnect: hub.type === 'private',
          hideFromEveryone: hub.type === 'private' && hub.hideFromEveryone,
        });
      } catch (err) {
        logger.warn({ err, hub: hub.channelId }, 'Could not create temp voice channel');
        await voice
          .notify(
            hub.channelId,
            `<@${e.userId}>, I couldn't create a channel right now (the category may be full or I'm missing permissions).`,
            15_000,
          )
          .catch(() => {});
        return;
      }

      this.d.db
        .insert(tempChannels)
        .values({
          channelId,
          guildId: this.d.guildId,
          hubChannelId: hub.channelId,
          ownerId: e.userId,
          occupants: [],
          renameTimestamps: [],
          createdAt: new Date(now),
        })
        .run();
      this.d.live?.publish('tempVoice');

      try {
        await voice.moveMember(e.userId, channelId);
      } catch (err) {
        // Most likely they left the hub before the channel was ready.
        if (voice.memberVoiceChannel(e.userId) !== channelId) {
          logger.debug({ err, channelId }, 'Owner left before being moved; deleting channel');
          await this.destroy(channelId, 'Owner left before the channel was ready');
        }
      }
    } finally {
      this.busyUsers.delete(e.userId);
    }
  }

  private onJoin(channelId: string, userId: string): void {
    this.cancelGrace(channelId);
    const row = this.getTemp(channelId);
    if (!row || row.occupants.some((o) => o.userId === userId)) return;
    this.saveOccupants(channelId, [...row.occupants, { userId, joinedAt: this.now() }]);
  }

  private async onLeave(channelId: string, userId: string): Promise<void> {
    const row = this.getTemp(channelId);
    if (!row) return;
    const present = this.d.voice.channelMembers(channelId);
    const occupants = row.occupants.filter((o) => o.userId !== userId && present.includes(o.userId));
    // Anyone connected but missing from the record (e.g. joined while the bot was down) goes to the back.
    for (const id of present) {
      if (!occupants.some((o) => o.userId === id)) occupants.push({ userId: id, joinedAt: this.now() });
    }
    this.saveOccupants(channelId, occupants);
    if (present.length === 0) {
      await this.scheduleDelete(channelId);
      return;
    }
    if (row.ownerId === userId) await this.handleOwnerGone(channelId, occupants);
  }

  private async handleOwnerGone(channelId: string, occupants: TempChannel['occupants']): Promise<void> {
    const mode = this.d.settings.get().voice.ownerLeaveMode;
    const next = [...occupants].sort((a, b) => a.joinedAt - b.joinedAt)[0];
    if (mode === 'transfer' && next) {
      await this.setOwner(channelId, next.userId);
      await this.d.voice
        .notify(channelId, `👑 The owner left, so <@${next.userId}> now owns this channel.`, 60_000)
        .catch(() => {});
      return;
    }
    this.setOwnerId(channelId, null);
    await this.d.voice
      .notify(channelId, 'The owner left. Anyone here can use `/vc claim` to take over.', 60_000)
      .catch(() => {});
  }

  private async scheduleDelete(channelId: string): Promise<void> {
    this.cancelGrace(channelId);
    const graceMs = this.d.settings.get().voice.graceSeconds * 1000;
    if (graceMs === 0) {
      await this.destroyIfEmpty(channelId);
      return;
    }
    const timer = setTimeout(() => {
      this.destroyIfEmpty(channelId).catch((err) =>
        this.d.logger.error({ err, channelId }, 'Grace deletion failed'),
      );
    }, graceMs);
    timer.unref?.();
    this.graceTimers.set(channelId, timer);
  }

  private cancelGrace(channelId: string): void {
    const t = this.graceTimers.get(channelId);
    if (t) clearTimeout(t);
    this.graceTimers.delete(channelId);
  }

  private async destroyIfEmpty(channelId: string): Promise<void> {
    this.graceTimers.delete(channelId);
    if (!this.isTempChannel(channelId)) return;
    if (this.d.voice.channelMembers(channelId).length > 0) return;
    await this.destroy(channelId, 'Temporary channel empty');
  }

  /** Delete the Discord channel and its record. Keeps the record if Discord refuses, so reconcile retries. */
  private async destroy(channelId: string, reason: string): Promise<void> {
    this.cancelGrace(channelId);
    this.recentlyDeleted.set(channelId, this.now());
    try {
      if (this.d.voice.channelExists(channelId)) await this.d.voice.deleteChannel(channelId, reason);
    } catch (err) {
      this.d.logger.warn(
        { err, channelId },
        'Could not delete temp voice channel; will retry on next reconcile',
      );
      return;
    }
    this.dropRecord(channelId);
  }

  private dropRecord(channelId: string): void {
    this.d.db
      .delete(tempChannels)
      .where(and(eq(tempChannels.guildId, this.d.guildId), eq(tempChannels.channelId, channelId)))
      .run();
    this.d.live?.publish('tempVoice');
  }

  /** A channel was deleted outside the bot (or by it). Clean up records. */
  onChannelDeleted(channelId: string): void {
    if (this.isTempChannel(channelId)) {
      this.cancelGrace(channelId);
      this.recentlyDeleted.set(channelId, this.now());
      this.dropRecord(channelId);
    }
    const hub = this.getHub(channelId);
    if (hub) {
      this.d.db
        .delete(voiceHubs)
        .where(and(eq(voiceHubs.guildId, this.d.guildId), eq(voiceHubs.channelId, channelId)))
        .run();
      this.d.audit.record(
        { id: 'system', source: 'system' },
        { action: 'voice.hub.remove', target: channelId, before: hub, after: null },
      );
      this.d.logger.warn({ channelId }, 'A voice hub channel was deleted; removed the hub');
    }
  }

  /**
   * Run on startup: delete empty tracked channels, drop records for channels that no longer exist,
   * resync occupants and ownership, and give anyone already waiting in a hub their channel.
   */
  async reconcile(): Promise<{ deleted: number; dropped: number; adopted: number }> {
    const { voice } = this.d;
    let deleted = 0;
    let dropped = 0;
    let adopted = 0;
    for (const row of this.listTemps()) {
      if (!voice.channelExists(row.channelId)) {
        this.dropRecord(row.channelId);
        dropped++;
        continue;
      }
      const present = voice.channelMembers(row.channelId);
      if (present.length === 0) {
        await this.destroy(row.channelId, 'Empty after restart');
        if (!this.isTempChannel(row.channelId)) deleted++;
        continue;
      }
      const kept = row.occupants.filter((o) => present.includes(o.userId));
      for (const userId of present) {
        if (!kept.some((o) => o.userId === userId)) kept.push({ userId, joinedAt: this.now() });
      }
      this.saveOccupants(row.channelId, kept);
      if (row.ownerId && !present.includes(row.ownerId)) await this.handleOwnerGone(row.channelId, kept);
    }
    for (const hub of this.listHubs()) {
      if (!voice.channelExists(hub.channelId)) {
        this.d.logger.warn({ hub: hub.channelId }, 'Voice hub channel no longer exists');
        continue;
      }
      for (const userId of voice.channelMembers(hub.channelId)) {
        const member = await this.d.guild.getMember(userId);
        if (!member) continue;
        await this.onHubJoin(hub, { userId, displayName: member.displayName, username: member.username });
        adopted++;
      }
    }
    return { deleted, dropped, adopted };
  }

  stop(): void {
    for (const t of this.graceTimers.values()) clearTimeout(t);
    this.graceTimers.clear();
  }

  private saveOccupants(channelId: string, occupants: TempChannel['occupants']): void {
    this.d.db.update(tempChannels).set({ occupants }).where(eq(tempChannels.channelId, channelId)).run();
    this.d.live?.publish('tempVoice');
  }

  private setOwnerId(channelId: string, ownerId: string | null): void {
    this.d.db.update(tempChannels).set({ ownerId }).where(eq(tempChannels.channelId, channelId)).run();
    this.d.live?.publish('tempVoice');
  }

  private async setOwner(channelId: string, userId: string): Promise<void> {
    this.setOwnerId(channelId, userId);
    await this.d.voice.setMemberAccess(channelId, userId, 'allow');
  }

  // ── Owner commands ───────────────────────────────────────────────────────

  /** The temp channel the actor is in; must be its owner unless `anyMember`. */
  private actorChannel(actorId: string, anyMember = false): TempChannel {
    const current = this.d.voice.memberVoiceChannel(actorId);
    if (!current) throw new UserError('Join your temporary voice channel first.');
    const row = this.getTemp(current);
    if (!row) throw new UserError("You're not in a temporary voice channel.");
    if (!anyMember && row.ownerId !== actorId) {
      throw new UserError(
        row.ownerId
          ? `Only the channel owner (<@${row.ownerId}>) can do that.`
          : 'This channel has no owner right now. Use `/vc claim` first.',
      );
    }
    return row;
  }

  async lock(actorId: string): Promise<string> {
    const row = this.actorChannel(actorId);
    // Let everyone already inside reconnect after the lock.
    for (const userId of this.d.voice.channelMembers(row.channelId)) {
      if (userId !== actorId) await this.d.voice.setMemberAccess(row.channelId, userId, 'allow');
    }
    await this.d.voice.setEveryoneDenied(row.channelId, true);
    return row.channelId;
  }

  async unlock(actorId: string): Promise<string> {
    const row = this.actorChannel(actorId);
    await this.d.voice.setEveryoneDenied(row.channelId, false);
    return row.channelId;
  }

  async setLimit(actorId: string, limit: number): Promise<string> {
    const row = this.actorChannel(actorId);
    await this.d.voice.setUserLimit(row.channelId, this.validLimit(limit));
    return row.channelId;
  }

  async rename(actorId: string, name: string): Promise<string> {
    const row = this.actorChannel(actorId);
    const clean = name.replace(/\s+/g, ' ').trim();
    if (!clean || clean.length > 100) throw new UserError('Channel names must be 1-100 characters.');
    const now = this.now();
    const wait = renameWaitMs(row.renameTimestamps, now);
    if (wait > 0) {
      const minutes = Math.ceil(wait / 60_000);
      throw new UserError(
        `Discord only allows ${RENAME_LIMIT} renames per 10 minutes. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`,
      );
    }
    await this.d.voice.rename(row.channelId, clean);
    const timestamps = [...row.renameTimestamps.filter((t) => now - t < RENAME_WINDOW_MS), now];
    this.d.db
      .update(tempChannels)
      .set({ renameTimestamps: timestamps })
      .where(eq(tempChannels.channelId, row.channelId))
      .run();
    return row.channelId;
  }

  async invite(actorId: string, targetId: string): Promise<string> {
    const row = this.actorChannel(actorId);
    if (targetId === actorId) throw new UserError('You already own this channel.');
    await this.d.voice.setMemberAccess(row.channelId, targetId, 'allow');
    return row.channelId;
  }

  async kick(actorId: string, targetId: string): Promise<{ channelId: string; disconnected: boolean }> {
    const row = this.actorChannel(actorId);
    if (targetId === actorId) throw new UserError("You can't kick yourself.");
    await this.d.voice.setMemberAccess(row.channelId, targetId, 'deny');
    const inside = this.d.voice.memberVoiceChannel(targetId) === row.channelId;
    if (inside) await this.d.voice.moveMember(targetId, null);
    return { channelId: row.channelId, disconnected: inside };
  }

  async transfer(actorId: string, targetId: string): Promise<string> {
    const row = this.actorChannel(actorId);
    if (targetId === actorId) throw new UserError('You already own this channel.');
    if (!this.d.voice.channelMembers(row.channelId).includes(targetId)) {
      throw new UserError('You can only transfer ownership to someone in the channel.');
    }
    await this.setOwner(row.channelId, targetId);
    return row.channelId;
  }

  async claim(actorId: string): Promise<string> {
    const row = this.actorChannel(actorId, true);
    if (row.ownerId === actorId) throw new UserError('You already own this channel.');
    if (row.ownerId && this.d.voice.channelMembers(row.channelId).includes(row.ownerId)) {
      throw new UserError(`The owner (<@${row.ownerId}>) is still here.`);
    }
    await this.setOwner(row.channelId, actorId);
    return row.channelId;
  }
}
