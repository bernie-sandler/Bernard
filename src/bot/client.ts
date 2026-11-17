import { Client, GatewayIntentBits, Options, Partials } from 'discord.js';

/**
 * Intents:
 *  - Guilds, GuildVoiceStates, GuildModeration, GuildMessages: non-privileged
 *  - GuildMessageReactions: non-privileged, reactions earn activity points
 *  - GuildMembers (privileged): joins/leaves, tenure backfill, role resolution
 *  - MessageContent (privileged): message edit/delete logs, link detection for activity
 * Both privileged intents must be enabled in the Discord Developer Portal (Bot → Privileged Gateway Intents).
 *
 * Partials.Reaction lets reactions on messages outside the cache through. Users are not partial:
 * every member is cached by the startup backfill.
 */
export function createDiscordClient(): Client {
  return new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.GuildMessageReactions,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildVoiceStates,
      GatewayIntentBits.GuildModeration,
    ],
    partials: [Partials.Message, Partials.Channel, Partials.GuildMember, Partials.Reaction],
    allowedMentions: { parse: [] },
    // Our own bounded MessageCache holds content for logs; keep discord.js's per-channel cache small.
    makeCache: Options.cacheWithLimits({ ...Options.DefaultMakeCacheSettings, MessageManager: 50 }),
  });
}
