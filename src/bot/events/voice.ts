import { type Client, Events } from 'discord.js';
import type { Logger } from '../../logger.js';
import type { Services } from '../../services/container.js';

/** Feed voice state changes and channel deletions to VoiceService. */
export function registerVoiceEvents(client: Client, services: Services, logger: Logger): void {
  const guildId = services.guild.guildId;

  client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
    if (newState.guild.id !== guildId || oldState.channelId === newState.channelId) return;
    const member = newState.member ?? oldState.member;
    if (!member) return;
    try {
      await services.voice.handleVoiceStateUpdate({
        userId: member.id,
        displayName: member.displayName,
        username: member.user.username,
        isBot: member.user.bot,
        from: oldState.channelId,
        to: newState.channelId,
      });
    } catch (err) {
      logger.error({ err, userId: member.id }, 'Voice state handler failed');
    }
    if (newState.channelId && !member.user.bot) {
      await services.thatsCrazy
        .onVoiceJoin(member.id)
        .catch((err) => logger.error({ err, userId: member.id }, "That's crazy join handler failed"));
    }
  });

  client.on(Events.ChannelDelete, (channel) => {
    if (channel.isDMBased() || channel.guildId !== guildId) return;
    try {
      services.voice.onChannelDeleted(channel.id);
    } catch (err) {
      logger.error({ err, channelId: channel.id }, 'Channel delete handler failed');
    }
  });
}
