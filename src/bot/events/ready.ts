import type { Client } from 'discord.js';
import type { Env } from '../../config/env.js';
import type { Logger } from '../../logger.js';
import type { BotStateStore } from '../../services/botState.js';
import type { Services } from '../../services/container.js';
import { registerCommands } from '../register.js';
import { inviteUrl, missingPermissions } from '../requiredPermissions.js';

/** Runs once the gateway is ready: sanity-check the guild, register commands, warn about setup gaps. */
export async function onReady(deps: {
  client: Client<true>;
  env: Env;
  services: Services;
  state: BotStateStore;
  logger: Logger;
}): Promise<void> {
  const { client, env, services, logger } = deps;
  logger.info({ user: client.user.tag }, 'Connected to Discord');

  const guild = client.guilds.cache.get(env.GUILD_ID);
  if (!guild) {
    logger.fatal(
      { guildId: env.GUILD_ID, invite: inviteUrl(env.DISCORD_CLIENT_ID, env.GUILD_ID) },
      'The bot is not in GUILD_ID. Invite it with the URL above, then restart.',
    );
    throw new Error('Bot is not a member of the configured guild');
  }

  const me = await guild.members.fetchMe();
  const missing = missingPermissions(me.permissions.bitfield);
  if (missing.length > 0) {
    logger.warn({ missing }, 'The bot is missing Discord permissions; some features will fail');
  }

  await registerCommands({
    token: env.DISCORD_TOKEN,
    clientId: env.DISCORD_CLIENT_ID,
    guildId: env.GUILD_ID,
    definitions: services.registry.definitions,
    state: deps.state,
    logger,
  });

  const voice = await services.voice.reconcile();
  logger.info(voice, 'Voice channels reconciled');

  if (!services.permissions.hasAnyRules()) {
    logger.warn(
      services.settings.get().permissions.adminBypass
        ? 'No permission rules exist yet. Only the server owner and members with Administrator can use admin/config commands until you run /permset.'
        : 'No permission rules exist yet. Only the server owner can use admin/config commands until you run /permset.',
    );
  }
}
