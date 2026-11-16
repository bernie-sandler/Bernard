import { type Client, EmbedBuilder, type Guild, type GuildMember, PermissionFlagsBits } from 'discord.js';
import type { ResultEmbed } from '../shared/commandResult.js';
import type { BotInfoPort, GuildPort, MemberInfo, MessengerPort, RoleInfo } from './ports.js';

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
  };
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

/**
 * GuildPort backed by a discord.js Client. The guild is looked up lazily so the adapter can be
 * built before the client is ready.
 */
export class DiscordGuildPort implements GuildPort {
  constructor(
    private readonly client: Client,
    readonly guildId: string,
  ) {}

  guild(): Guild {
    const g = this.client.guilds.cache.get(this.guildId);
    if (!g) throw new Error(`Bot is not in guild ${this.guildId}`);
    return g;
  }

  ownerId(): string {
    return this.guild().ownerId;
  }

  async getMember(userId: string): Promise<MemberInfo | null> {
    try {
      const m = await this.guild().members.fetch(userId);
      return toMemberInfo(m);
    } catch {
      return null;
    }
  }

  getRole(roleId: string): RoleInfo | null {
    const r = this.guild().roles.cache.get(roleId);
    if (!r) return null;
    return { id: r.id, name: r.name, position: r.position, managed: r.managed, color: r.color };
  }

  roleName(roleId: string): string {
    if (roleId === this.guildId) return '@everyone';
    const r = this.client.guilds.cache.get(this.guildId)?.roles.cache.get(roleId);
    return r ? `@${r.name}` : `<@&${roleId}>`;
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
}
