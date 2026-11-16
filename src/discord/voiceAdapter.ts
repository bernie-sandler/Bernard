import {
  ChannelType,
  type Client,
  type Guild,
  type OverwriteResolvable,
  PermissionFlagsBits,
  type VoiceChannel,
} from 'discord.js';
import type { CreateVoiceChannelOptions, VoicePort } from './ports.js';

/** VoicePort backed by discord.js. Voice states come from the GuildVoiceStates intent cache. */
export class DiscordVoice implements VoicePort {
  constructor(
    private readonly client: Client,
    private readonly guildId: string,
  ) {}

  private guild(): Guild {
    const g = this.client.guilds.cache.get(this.guildId);
    if (!g) throw new Error(`Bot is not in guild ${this.guildId}`);
    return g;
  }

  private voiceChannel(channelId: string): VoiceChannel {
    const c = this.guild().channels.cache.get(channelId);
    if (!c || c.type !== ChannelType.GuildVoice)
      throw new Error(`Channel ${channelId} is not a voice channel`);
    return c;
  }

  async createVoiceChannel(opts: CreateVoiceChannelOptions): Promise<string> {
    const guild = this.guild();
    const botId = this.client.user!.id;
    const overwrites: OverwriteResolvable[] = [
      {
        id: opts.ownerId,
        allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak],
      },
      // The bot must keep access to manage and move members into the channel, even when @everyone is denied.
      {
        id: botId,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.Connect,
          PermissionFlagsBits.ManageChannels,
          PermissionFlagsBits.MoveMembers,
          PermissionFlagsBits.SendMessages,
        ],
      },
    ];
    if (opts.denyEveryoneConnect || opts.hideFromEveryone) {
      overwrites.push({
        id: guild.id,
        deny: [
          PermissionFlagsBits.Connect,
          ...(opts.hideFromEveryone ? [PermissionFlagsBits.ViewChannel] : []),
        ],
      });
    }
    const channel = await guild.channels.create({
      name: opts.name.slice(0, 100),
      type: ChannelType.GuildVoice,
      parent: opts.categoryId,
      userLimit: Math.max(0, Math.min(99, opts.userLimit)),
      permissionOverwrites: overwrites,
      reason: 'Join-to-create voice channel',
    });
    return channel.id;
  }

  async deleteChannel(channelId: string, reason?: string): Promise<void> {
    const c = this.guild().channels.cache.get(channelId);
    if (c) await c.delete(reason);
  }

  async moveMember(userId: string, channelId: string | null): Promise<void> {
    const member = await this.guild().members.fetch(userId);
    await member.voice.setChannel(channelId);
  }

  channelExists(channelId: string): boolean {
    return this.guild().channels.cache.has(channelId);
  }

  channelMembers(channelId: string): string[] {
    const c = this.guild().channels.cache.get(channelId);
    if (!c || !c.isVoiceBased()) return [];
    return [...c.members.values()].filter((m) => !m.user.bot).map((m) => m.id);
  }

  memberVoiceChannel(userId: string): string | null {
    return this.guild().voiceStates.cache.get(userId)?.channelId ?? null;
  }

  async setUserLimit(channelId: string, limit: number): Promise<void> {
    await this.voiceChannel(channelId).setUserLimit(limit);
  }

  async rename(channelId: string, name: string): Promise<void> {
    await this.voiceChannel(channelId).setName(name.slice(0, 100));
  }

  async setEveryoneDenied(channelId: string, denied: boolean): Promise<void> {
    await this.voiceChannel(channelId).permissionOverwrites.edit(this.guildId, {
      Connect: denied ? false : null,
    });
  }

  async setMemberAccess(channelId: string, userId: string, access: 'allow' | 'deny' | null): Promise<void> {
    const c = this.voiceChannel(channelId);
    if (access === null) {
      await c.permissionOverwrites.delete(userId);
      return;
    }
    await c.permissionOverwrites.edit(
      userId,
      access === 'allow' ? { Connect: true, ViewChannel: true, Speak: true } : { Connect: false },
    );
  }

  async notify(channelId: string, text: string, deleteAfterMs?: number): Promise<void> {
    const c = this.guild().channels.cache.get(channelId);
    if (!c || !c.isSendable()) return;
    const msg = await c.send({ content: text.slice(0, 2000), allowedMentions: { parse: ['users'] } });
    if (deleteAfterMs) setTimeout(() => void msg.delete().catch(() => {}), deleteAfterMs).unref();
  }
}
