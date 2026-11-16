import { Client, GatewayIntentBits, Partials } from 'discord.js';

/**
 * Intents:
 *  - Guilds, GuildVoiceStates, GuildModeration, GuildMessages: non-privileged
 *  - GuildMembers (privileged): joins/leaves, tenure backfill, role resolution
 *  - MessageContent (privileged): message edit/delete logs
 * Both privileged intents must be enabled in the Discord Developer Portal (Bot → Privileged Gateway Intents).
 */
export function createDiscordClient(): Client {
  return new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildVoiceStates,
      GatewayIntentBits.GuildModeration,
    ],
    partials: [Partials.Message, Partials.Channel, Partials.GuildMember],
    allowedMentions: { parse: [] },
  });
}
