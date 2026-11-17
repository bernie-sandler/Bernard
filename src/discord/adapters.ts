import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type Channel,
  ChannelType,
  type Client,
  EmbedBuilder,
  type Guild,
  type GuildMember,
  type MessageActionRowComponentBuilder,
  PermissionFlagsBits,
  type PermissionsString,
  type Role,
  StringSelectMenuBuilder,
} from 'discord.js';
import type { ResultEmbed } from '../shared/commandResult.js';
import type { OutgoingMessage } from '../shared/messages.js';
import type {
  BotInfoPort,
  ChannelInfo,
  ChannelKindName,
  GuildPort,
  GuildSummary,
  LockState,
  MemberInfo,
  MessageSummary,
  MessengerPort,
  ModerationPort,
  RoleInfo,
  UserInfo,
} from './ports.js';

export function toMemberInfo(member: GuildMember): MemberInfo {
  return {
    userId: member.id,
    username: member.user.username,
    displayName: member.displayName,
    avatarUrl: member.displayAvatarURL({ size: 128 }),
    isBot: member.user.bot,
    roleIds: [...member.roles.cache.keys()],
    isOwner: member.guild.ownerId === member.id,
    isAdministrator: member.permissions.has(PermissionFlagsBits.Administrator),
    highestRolePosition: member.roles.highest.position,
    joinedAt: member.joinedAt,
    createdAt: member.user.createdAt,
    communicationDisabledUntil: member.isCommunicationDisabled() ? member.communicationDisabledUntil : null,
    nickname: member.nickname,
  };
}

export function channelKind(c: Channel): ChannelKindName {
  switch (c.type) {
    case ChannelType.GuildText:
      return 'text';
    case ChannelType.GuildVoice:
      return 'voice';
    case ChannelType.GuildCategory:
      return 'category';
    case ChannelType.GuildAnnouncement:
      return 'announcement';
    case ChannelType.GuildStageVoice:
      return 'stage';
    case ChannelType.GuildForum:
      return 'forum';
    case ChannelType.PublicThread:
    case ChannelType.PrivateThread:
    case ChannelType.AnnouncementThread:
      return 'thread';
    default:
      return 'other';
  }
}

export function toEmbed(e: ResultEmbed): EmbedBuilder {
  const b = new EmbedBuilder();
  if (e.title) b.setTitle(e.title.slice(0, 256));
  if (e.description) b.setDescription(e.description.slice(0, 4096));
  if (e.color !== undefined) b.setColor(e.color);
  if (e.fields?.length) {
    b.addFields(
      e.fields.slice(0, 25).map((f) => ({
        name: f.name.slice(0, 256) || '​',
        value: f.value.slice(0, 1024) || '​',
        inline: f.inline ?? false,
      })),
    );
  }
  if (e.footer) b.setFooter({ text: e.footer.slice(0, 2048) });
  if (e.timestamp) b.setTimestamp(new Date(e.timestamp));
  if (e.thumbnailUrl) b.setThumbnail(e.thumbnailUrl);
  return b;
}

/** Shared lazy guild lookup so adapters can be built before the client is ready. */
/** Permissions that make a role unsafe to hand out from a self-assign panel. */
const ELEVATED_PERMISSIONS = [
  PermissionFlagsBits.Administrator,
  PermissionFlagsBits.ManageGuild,
  PermissionFlagsBits.ManageRoles,
  PermissionFlagsBits.ManageChannels,
  PermissionFlagsBits.ManageMessages,
  PermissionFlagsBits.ManageWebhooks,
  PermissionFlagsBits.ManageNicknames,
  PermissionFlagsBits.ManageGuildExpressions,
  PermissionFlagsBits.ManageEvents,
  PermissionFlagsBits.ManageThreads,
  PermissionFlagsBits.BanMembers,
  PermissionFlagsBits.KickMembers,
  PermissionFlagsBits.ModerateMembers,
  PermissionFlagsBits.MoveMembers,
  PermissionFlagsBits.MuteMembers,
  PermissionFlagsBits.DeafenMembers,
  PermissionFlagsBits.MentionEveryone,
  PermissionFlagsBits.ViewAuditLog,
];

export function toRoleInfo(r: Role): RoleInfo {
  return {
    id: r.id,
    name: r.name,
    position: r.position,
    managed: r.managed,
    color: r.color,
    elevated: r.permissions.any(ELEVATED_PERMISSIONS, false),
  };
}

const BUTTON_STYLES = {
  primary: ButtonStyle.Primary,
  secondary: ButtonStyle.Secondary,
  success: ButtonStyle.Success,
  danger: ButtonStyle.Danger,
} as const;

/** Build the discord.js payload for an OutgoingMessage (used for both send and edit). */
export function toMessagePayload(msg: OutgoingMessage) {
  const rows: ActionRowBuilder<MessageActionRowComponentBuilder>[] = [];
  const buttons = (msg.buttons ?? []).slice(0, 25);
  for (let i = 0; i < buttons.length; i += 5) {
    rows.push(
      new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
        buttons.slice(i, i + 5).map((b) => {
          const btn = new ButtonBuilder()
            .setCustomId(b.customId)
            .setLabel(b.label.slice(0, 80))
            .setStyle(BUTTON_STYLES[b.style ?? 'secondary']);
          if (b.emoji) btn.setEmoji(b.emoji);
          return btn;
        }),
      ),
    );
  }
  if (msg.select && msg.select.options.length > 0) {
    const sel = msg.select;
    const menu = new StringSelectMenuBuilder()
      .setCustomId(sel.customId)
      .setMinValues(sel.minValues)
      .setMaxValues(Math.min(sel.maxValues, sel.options.length))
      .addOptions(
        sel.options.slice(0, 25).map((o) => ({
          value: o.value,
          label: o.label.slice(0, 100),
          ...(o.description ? { description: o.description.slice(0, 100) } : {}),
          ...(o.emoji ? { emoji: o.emoji } : {}),
        })),
      );
    if (sel.placeholder) menu.setPlaceholder(sel.placeholder.slice(0, 150));
    rows.push(new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(menu));
  }
  return {
    content: msg.content ? msg.content.slice(0, 2000) : null,
    embeds: msg.embed ? [toEmbed(msg.embed)] : [],
    components: rows,
    allowedMentions: { parse: [], roles: msg.mentionRoleIds ?? [] },
  };
}

/** Discord error codes meaning the channel or message is gone. */
const GONE_CODES = new Set([10003, 10008]);
const isGone = (err: unknown) =>
  typeof err === 'object' && err !== null && GONE_CODES.has((err as { code?: number }).code ?? 0);

abstract class GuildBound {
  constructor(
    protected readonly client: Client,
    readonly guildId: string,
  ) {}

  guild(): Guild {
    const g = this.client.guilds.cache.get(this.guildId);
    if (!g) throw new Error(`Bot is not in guild ${this.guildId}`);
    return g;
  }
}

export class DiscordGuildPort extends GuildBound implements GuildPort {
  ownerId(): string {
    return this.guild().ownerId;
  }

  summary(): GuildSummary {
    const g = this.guild();
    const counts = { text: 0, voice: 0, category: 0, other: 0 };
    for (const c of g.channels.cache.values()) {
      const k = channelKind(c);
      if (k === 'text' || k === 'announcement' || k === 'forum') counts.text++;
      else if (k === 'voice' || k === 'stage') counts.voice++;
      else if (k === 'category') counts.category++;
      else counts.other++;
    }
    return {
      id: g.id,
      name: g.name,
      ownerId: g.ownerId,
      iconUrl: g.iconURL({ size: 256 }),
      createdAt: g.createdAt,
      memberCount: g.memberCount,
      roleCount: g.roles.cache.size,
      channelCounts: counts,
      boostTier: g.premiumTier,
      boostCount: g.premiumSubscriptionCount ?? 0,
    };
  }

  async getMember(userId: string): Promise<MemberInfo | null> {
    try {
      return toMemberInfo(await this.guild().members.fetch(userId));
    } catch {
      return null;
    }
  }

  async getUser(userId: string): Promise<UserInfo | null> {
    try {
      const u = await this.client.users.fetch(userId);
      return {
        userId: u.id,
        username: u.username,
        avatarUrl: u.displayAvatarURL({ size: 128 }),
        isBot: u.bot,
        createdAt: u.createdAt,
      };
    } catch {
      return null;
    }
  }

  getRole(roleId: string): RoleInfo | null {
    const r = this.guild().roles.cache.get(roleId);
    if (!r) return null;
    return toRoleInfo(r);
  }

  listChannels(): ChannelInfo[] {
    const all = [...this.guild().channels.cache.values()].filter((c) => !c.isThread());
    const pos = (c: (typeof all)[number]) => ('rawPosition' in c ? c.rawPosition : 0);
    const catPos = new Map(
      all.filter((c) => c.type === ChannelType.GuildCategory).map((c) => [c.id, pos(c)]),
    );
    // Uncategorised first, then each category followed by its children (Discord's order).
    const key = (c: (typeof all)[number]): [number, number, number] =>
      c.type === ChannelType.GuildCategory
        ? [catPos.get(c.id)! + 1, 0, 0]
        : [c.parentId ? (catPos.get(c.parentId) ?? 0) + 1 : 0, 1, pos(c)];
    return all
      .sort((a, b) => {
        const ka = key(a);
        const kb = key(b);
        return ka[0] - kb[0] || ka[1] - kb[1] || ka[2] - kb[2];
      })
      .map((c) => ({ id: c.id, name: c.name, kind: channelKind(c), parentId: c.parentId, position: pos(c) }));
  }

  getChannel(channelId: string): ChannelInfo | null {
    const c = this.guild().channels.cache.get(channelId);
    if (!c) return null;
    return { id: c.id, name: c.name, kind: channelKind(c), parentId: c.parentId };
  }

  roleName(roleId: string): string {
    if (roleId === this.guildId) return '@everyone';
    const r = this.client.guilds.cache.get(this.guildId)?.roles.cache.get(roleId);
    return r ? `@${r.name}` : `<@&${roleId}>`;
  }

  async listMembers(): Promise<MemberInfo[]> {
    const members = await this.guild().members.fetch();
    return [...members.values()].map(toMemberInfo);
  }

  cachedMember(userId: string): MemberInfo | null {
    const m = this.guild().members.cache.get(userId);
    return m ? toMemberInfo(m) : null;
  }

  listRoles(): RoleInfo[] {
    return [...this.guild().roles.cache.values()]
      .filter((r) => r.id !== this.guildId)
      .sort((a, b) => b.position - a.position)
      .map(toRoleInfo);
  }

  private countsCache: { at: number; value: { members: number; online: number } } | null = null;

  async approximateCounts(): Promise<{ members: number; online: number } | null> {
    if (this.countsCache && Date.now() - this.countsCache.at < 60_000) return this.countsCache.value;
    try {
      // with_counts works without the privileged presence intent.
      const g = await this.client.guilds.fetch({ guild: this.guildId, withCounts: true, force: true });
      const value = {
        members: g.approximateMemberCount ?? g.memberCount,
        online: g.approximatePresenceCount ?? 0,
      };
      this.countsCache = { at: Date.now(), value };
      return value;
    } catch {
      return this.countsCache?.value ?? null;
    }
  }

  roleMemberCount(roleId: string): number {
    return this.guild().roles.cache.get(roleId)?.members.size ?? 0;
  }

  botMember(): { userId: string; highestRolePosition: number } {
    const me = this.guild().members.me;
    if (!me) throw new Error('Bot member not cached');
    return { userId: me.id, highestRolePosition: me.roles.highest.position };
  }
}

const LOCK_PERMS: PermissionsString[] = [
  'SendMessages',
  'SendMessagesInThreads',
  'CreatePublicThreads',
  'CreatePrivateThreads',
];

export class DiscordModeration extends GuildBound implements ModerationPort {
  async ban(userId: string, opts: { reason?: string; deleteMessageSeconds?: number }): Promise<void> {
    await this.guild().bans.create(userId, {
      ...(opts.reason ? { reason: opts.reason } : {}),
      ...(opts.deleteMessageSeconds ? { deleteMessageSeconds: opts.deleteMessageSeconds } : {}),
    });
  }

  async unban(userId: string, reason?: string): Promise<void> {
    await this.guild().bans.remove(userId, reason);
  }

  async isBanned(userId: string): Promise<boolean> {
    try {
      await this.guild().bans.fetch({ user: userId, force: true });
      return true;
    } catch {
      return false;
    }
  }

  async kick(userId: string, reason?: string): Promise<void> {
    await this.guild().members.kick(userId, reason);
  }

  async timeout(userId: string, ms: number | null, reason?: string): Promise<void> {
    const member = await this.guild().members.fetch(userId);
    await member.timeout(ms, reason);
  }

  async setNickname(userId: string, nickname: string | null, reason?: string): Promise<void> {
    const member = await this.guild().members.fetch(userId);
    await member.setNickname(nickname, reason);
  }

  async addRole(userId: string, roleId: string, reason?: string): Promise<void> {
    await this.guild().members.addRole({ user: userId, role: roleId, ...(reason ? { reason } : {}) });
  }

  async removeRole(userId: string, roleId: string, reason?: string): Promise<void> {
    await this.guild().members.removeRole({ user: userId, role: roleId, ...(reason ? { reason } : {}) });
  }

  private async textChannel(channelId: string) {
    const c = await this.guild().channels.fetch(channelId);
    if (!c || !c.isTextBased()) throw new Error(`Channel ${channelId} is not a text channel`);
    return c;
  }

  async fetchMessages(channelId: string, limit: number, before?: string): Promise<MessageSummary[]> {
    const c = await this.textChannel(channelId);
    const msgs = await c.messages.fetch({ limit: Math.min(limit, 100), ...(before ? { before } : {}) });
    return [...msgs.values()]
      .sort((a, b) => b.createdTimestamp - a.createdTimestamp)
      .map((m) => ({ id: m.id, authorId: m.author.id, createdAt: m.createdAt, pinned: m.pinned }));
  }

  async deleteMessages(channelId: string, ids: string[], reason?: string): Promise<number> {
    const c = await this.textChannel(channelId);
    if (ids.length === 0) return 0;
    if (ids.length === 1) {
      await c.messages.delete(ids[0]!);
      return 1;
    }
    if (!('bulkDelete' in c)) throw new Error('Channel does not support bulk delete');
    let deleted = 0;
    for (let i = 0; i < ids.length; i += 100) {
      const res = await c.bulkDelete(ids.slice(i, i + 100), true);
      deleted += res.size;
    }
    void reason; // bulk delete has no audit-log reason
    return deleted;
  }

  async setSlowmode(channelId: string, seconds: number, reason?: string): Promise<void> {
    const c = await this.guild().channels.fetch(channelId);
    if (!c || !('setRateLimitPerUser' in c)) throw new Error('That channel does not support slowmode');
    await c.setRateLimitPerUser(seconds, reason);
  }

  async setLocked(
    channelId: string,
    locked: boolean,
    previous?: LockState,
    reason?: string,
  ): Promise<LockState> {
    const c = await this.guild().channels.fetch(channelId);
    if (!c || !('permissionOverwrites' in c)) throw new Error('That channel cannot be locked');
    const everyone = this.guildId;
    const current = c.permissionOverwrites.cache.get(everyone);
    const state: LockState = {};
    for (const p of LOCK_PERMS) {
      state[p] = current?.allow.has(p) ? true : current?.deny.has(p) ? false : null;
    }
    const next: Partial<Record<PermissionsString, boolean | null>> = {};
    for (const p of LOCK_PERMS) next[p] = locked ? false : (previous?.[p] ?? null);
    await c.permissionOverwrites.edit(everyone, next, reason ? { reason } : {});
    return state;
  }

  async sendMessage(channelId: string, msg: { content?: string; embed?: ResultEmbed }): Promise<string> {
    const c = await this.guild().channels.fetch(channelId);
    if (!c || !c.isSendable()) throw new Error('I cannot send messages in that channel');
    const sent = await c.send({
      ...(msg.content ? { content: msg.content } : {}),
      ...(msg.embed ? { embeds: [toEmbed(msg.embed)] } : {}),
      allowedMentions: { parse: ['users', 'roles'] },
    });
    return sent.id;
  }

  async dm(userId: string, text: string): Promise<boolean> {
    try {
      const user = await this.client.users.fetch(userId);
      await user.send({ content: text.slice(0, 2000), allowedMentions: { parse: [] } });
      return true;
    } catch {
      return false;
    }
  }
}

export class DiscordMessenger implements MessengerPort {
  constructor(private readonly client: Client) {}

  async sendEmbed(channelId: string, embed: ResultEmbed): Promise<string | null> {
    const channel = await this.client.channels.fetch(channelId).catch(() => null);
    if (!channel || !channel.isSendable()) return null;
    const msg = await channel.send({ embeds: [toEmbed(embed)], allowedMentions: { parse: [] } });
    return msg.id;
  }

  private async sendable(channelId: string) {
    const channel = await this.client.channels.fetch(channelId).catch((err) => {
      if (isGone(err)) return null;
      throw err;
    });
    return channel?.isSendable() ? channel : null;
  }

  async send(channelId: string, msg: OutgoingMessage): Promise<string | null> {
    const channel = await this.sendable(channelId);
    if (!channel) return null;
    const { content, ...rest } = toMessagePayload(msg);
    const sent = await channel.send({ ...rest, ...(content ? { content } : {}) });
    return sent.id;
  }

  async edit(channelId: string, messageId: string, msg: OutgoingMessage): Promise<boolean> {
    const channel = await this.sendable(channelId);
    if (!channel) return false;
    try {
      await channel.messages.edit(messageId, toMessagePayload(msg));
      return true;
    } catch (err) {
      if (isGone(err)) return false;
      throw err;
    }
  }

  async pin(channelId: string, messageId: string): Promise<boolean> {
    try {
      const channel = await this.sendable(channelId);
      if (!channel) return false;
      await channel.messages.pin(messageId);
      return true;
    } catch {
      return false;
    }
  }

  async delete(channelId: string, messageId: string): Promise<void> {
    const channel = await this.sendable(channelId);
    if (!channel) return;
    await channel.messages.delete(messageId).catch((err) => {
      if (!isGone(err)) throw err;
    });
  }
}

export class DiscordBotInfo implements BotInfoPort {
  constructor(private readonly client: Client) {}
  isReady(): boolean {
    return this.client.isReady();
  }
  wsPingMs(): number {
    return this.client.ws.ping;
  }
  uptimeMs(): number {
    return this.client.uptime ?? 0;
  }
  userId(): string | null {
    return this.client.user?.id ?? null;
  }
}
