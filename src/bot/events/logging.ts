import {
  type Client,
  Events,
  type GuildBasedChannel,
  type Message,
  type PartialMessage,
  type Role,
} from 'discord.js';
import { channelKind } from '../../discord/adapters.js';
import type { Logger } from '../../logger.js';
import type { Services } from '../../services/container.js';
import { type ChannelSnapshot, diffChannel, diffRole, type RoleSnapshot } from '../../services/eventLog.js';
import type { CachedMessage } from '../../services/messageCache.js';
import { mapAuditEntry } from '../../services/moderation/external.js';

const TEMP_CHANNEL_SETTLE_MS = 3000;

function roleSnapshot(r: Role): RoleSnapshot {
  return {
    id: r.id,
    name: r.name,
    color: r.color,
    hoist: r.hoist,
    mentionable: r.mentionable,
    permissions: r.permissions.toArray(),
  };
}

function channelSnapshot(c: GuildBasedChannel): ChannelSnapshot {
  const overwrites =
    'permissionOverwrites' in c
      ? [...c.permissionOverwrites.cache.values()]
          .map((o) => `${o.id}:${o.allow.bitfield}:${o.deny.bitfield}`)
          .sort()
          .join('|')
      : '';
  return {
    id: c.id,
    name: c.name,
    kind: channelKind(c),
    topic: 'topic' in c ? (c.topic ?? null) : null,
    nsfw: 'nsfw' in c ? Boolean(c.nsfw) : false,
    rateLimitPerUser: 'rateLimitPerUser' in c ? (c.rateLimitPerUser ?? 0) : 0,
    parentId: c.parentId,
    userLimit: 'userLimit' in c ? (c.userLimit ?? 0) : 0,
    overwrites,
  };
}

function toCached(m: Message): CachedMessage {
  return {
    id: m.id,
    channelId: m.channelId,
    authorId: m.author.id,
    authorTag: m.author.tag,
    content: m.content,
    attachments: [...m.attachments.values()].map((a) => ({ name: a.name, url: a.url })),
    createdAt: m.createdTimestamp,
  };
}

/**
 * Wire Discord gateway events to the logging services. Handlers only translate discord.js objects
 * into plain data; the services decide what to log.
 */
export function registerLoggingEvents(client: Client, services: Services, logger: Logger): void {
  const { eventLog, messageCache, moderation, guild } = services;
  const guildId = guild.guildId;

  /** Run a handler without letting one failure crash the process. */
  const safe =
    <A extends unknown[]>(name: string, fn: (...args: A) => Promise<void> | void) =>
    async (...args: A) => {
      try {
        await fn(...args);
      } catch (err) {
        logger.error({ err, event: name }, 'Event handler failed');
      }
    };

  // ── Messages ─────────────────────────────────────────────────────────────

  client.on(
    Events.MessageCreate,
    safe('messageCreate', (m: Message) => {
      if (m.guildId !== guildId || m.author.bot || m.system) return;
      messageCache.set(toCached(m));
    }),
  );

  client.on(
    Events.MessageUpdate,
    safe('messageUpdate', async (oldMsg: Message | PartialMessage, newMsg: Message | PartialMessage) => {
      if (newMsg.guildId !== guildId || eventLog.isLogChannel(newMsg.channelId)) return;
      const msg = newMsg.partial ? await newMsg.fetch().catch(() => null) : newMsg;
      if (!msg || msg.author.bot || msg.system) return;
      const cached = messageCache.get(msg.id);
      const before = cached?.content ?? (oldMsg.partial ? null : oldMsg.content);
      messageCache.set(toCached(msg));
      await eventLog.messageEdited({
        messageId: msg.id,
        channelId: msg.channelId,
        authorId: msg.author.id,
        authorTag: msg.author.tag,
        before,
        after: msg.content,
        url: msg.url,
      });
    }),
  );

  client.on(
    Events.MessageDelete,
    safe('messageDelete', async (msg: Message | PartialMessage) => {
      if (msg.guildId !== guildId || eventLog.isLogChannel(msg.channelId)) return;
      const cached = messageCache.take(msg.id) ?? (!msg.partial && !msg.author.bot ? toCached(msg) : null);
      if (!cached && !msg.partial && msg.author.bot) return;
      await eventLog.messageDeleted({ messageId: msg.id, channelId: msg.channelId, cached });
    }),
  );

  client.on(
    Events.MessageBulkDelete,
    safe('messageBulkDelete', async (messages, channel) => {
      if (channel.guildId !== guildId || eventLog.isLogChannel(channel.id)) return;
      const ids = [...messages.keys()];
      const cached = ids.map((id) => messageCache.take(id)).filter((m): m is CachedMessage => Boolean(m));
      await eventLog.messagesBulkDeleted({ channelId: channel.id, ids, cached });
    }),
  );

  // ── Members ──────────────────────────────────────────────────────────────

  client.on(
    Events.GuildMemberAdd,
    safe('guildMemberAdd', async (member) => {
      if (member.guild.id !== guildId) return;
      await eventLog.memberJoined({
        userId: member.id,
        tag: member.user.tag,
        avatarUrl: member.displayAvatarURL({ size: 128 }),
        accountCreatedAt: member.user.createdAt,
        memberCount: member.guild.memberCount,
        isBot: member.user.bot,
      });
    }),
  );

  client.on(
    Events.GuildMemberRemove,
    safe('guildMemberRemove', async (member) => {
      if (member.guild.id !== guildId) return;
      await eventLog.memberLeft({
        userId: member.id,
        tag: member.user?.tag ?? member.id,
        joinedAt: member.joinedAt,
        roleIds: [...member.roles.cache.keys()].filter((r) => r !== guildId),
      });
    }),
  );

  client.on(
    Events.GuildMemberUpdate,
    safe('guildMemberUpdate', async (oldMember, newMember) => {
      if (newMember.guild.id !== guildId || oldMember.partial) return;
      if (oldMember.nickname !== newMember.nickname) {
        await eventLog.nicknameChanged({
          userId: newMember.id,
          tag: newMember.user.tag,
          before: oldMember.nickname,
          after: newMember.nickname,
        });
      }
      const before = new Set(oldMember.roles.cache.keys());
      const after = new Set(newMember.roles.cache.keys());
      const added = [...after].filter((r) => !before.has(r));
      const removed = [...before].filter((r) => !after.has(r));
      await eventLog.memberRolesChanged({ userId: newMember.id, tag: newMember.user.tag, added, removed });
    }),
  );

  // ── Voice ────────────────────────────────────────────────────────────────

  client.on(
    Events.VoiceStateUpdate,
    safe('voiceStateUpdate', async (oldState, newState) => {
      if (newState.guild.id !== guildId || oldState.channelId === newState.channelId) return;
      const member = newState.member ?? oldState.member;
      if (!member || member.user.bot) return;
      await eventLog.voiceChanged({
        userId: member.id,
        tag: member.user.tag,
        from: oldState.channelId,
        to: newState.channelId,
      });
    }),
  );

  // ── Server structure ─────────────────────────────────────────────────────

  client.on(
    Events.GuildRoleCreate,
    safe('roleCreate', async (r) => {
      if (r.guild.id === guildId) await eventLog.roleEvent('create', roleSnapshot(r));
    }),
  );
  client.on(
    Events.GuildRoleDelete,
    safe('roleDelete', async (r) => {
      if (r.guild.id === guildId) await eventLog.roleEvent('delete', roleSnapshot(r));
    }),
  );
  client.on(
    Events.GuildRoleUpdate,
    safe('roleUpdate', async (a, b) => {
      if (b.guild.id !== guildId) return;
      const before = roleSnapshot(a);
      const after = roleSnapshot(b);
      await eventLog.roleEvent('update', after, diffRole(before, after));
    }),
  );

  const isGuildChannel = (c: { isDMBased(): boolean }): c is GuildBasedChannel => !c.isDMBased();
  client.on(
    Events.ChannelCreate,
    safe('channelCreate', async (c) => {
      if (c.guildId !== guildId) return;
      // The gateway event can beat VoiceService's DB insert, so wait briefly before checking for temp channels.
      await new Promise((r) => setTimeout(r, TEMP_CHANNEL_SETTLE_MS));
      if (services.voice.isManagedChannel(c.id)) return;
      await eventLog.channelEvent('create', channelSnapshot(c));
    }),
  );
  client.on(
    Events.ChannelDelete,
    safe('channelDelete', async (c) => {
      if (!isGuildChannel(c) || c.guildId !== guildId || services.voice.isManagedChannel(c.id)) return;
      await eventLog.channelEvent('delete', channelSnapshot(c));
    }),
  );
  client.on(
    Events.ChannelUpdate,
    safe('channelUpdate', async (a, b) => {
      if (!isGuildChannel(a) || !isGuildChannel(b) || b.guildId !== guildId) return;
      if (services.voice.isManagedChannel(b.id)) return; // temp voice channels change constantly
      const before = channelSnapshot(a);
      const after = channelSnapshot(b);
      await eventLog.channelEvent('update', after, diffChannel(before, after));
    }),
  );

  // ── Native moderation (bans/kicks/timeouts done in Discord's UI) ─────────

  client.on(
    Events.GuildAuditLogEntryCreate,
    safe('auditLogEntryCreate', async (entry, g) => {
      if (g.id !== guildId) return;
      const mapped = mapAuditEntry(
        {
          action: entry.action,
          executorId: entry.executorId,
          targetId: entry.targetId,
          reason: entry.reason,
          changes: entry.changes.map((c) => ({ key: c.key, old: c.old, new: c.new })),
          createdAt: entry.createdAt,
        },
        client.user?.id ?? null,
      );
      if (mapped) await moderation.recordExternal(mapped);
    }),
  );
}
