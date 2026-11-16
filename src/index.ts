import { Events } from 'discord.js';
import { createApiServer } from './api/server.js';
import { createDiscordClient } from './bot/client.js';
import { allCommands } from './bot/commands/index.js';
import { onReady } from './bot/events/ready.js';
import { createInteractionHandler } from './bot/interactions.js';
import { ConfigError, type Env, loadEnv } from './config/env.js';
import { openDb, runMigrations } from './db/client.js';
import { DiscordBotInfo, DiscordGuildPort, DiscordMessenger } from './discord/adapters.js';
import { createLogger } from './logger.js';
import { BotStateStore } from './services/botState.js';
import { createContainer } from './services/container.js';

function loadEnvOrExit(): Env {
  try {
    return loadEnv();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }
}

async function main(): Promise<void> {
  const env = loadEnvOrExit();
  const logger = createLogger({ level: env.LOG_LEVEL, pretty: env.LOG_PRETTY });
  const startedAt = new Date();

  const dbHandle = openDb(env.DATABASE_PATH);
  runMigrations(dbHandle, env.MIGRATIONS_DIR);
  logger.info({ path: env.DATABASE_PATH }, 'Database ready');

  const client = createDiscordClient();
  const container = createContainer({
    db: dbHandle.db,
    logger,
    guild: new DiscordGuildPort(client, env.GUILD_ID),
    messenger: new DiscordMessenger(client),
    bot: new DiscordBotInfo(client),
    commands: allCommands,
  });
  const state = new BotStateStore(dbHandle.db, env.GUILD_ID);

  client.once(Events.ClientReady, (c) => {
    onReady({ client: c, env, services: container.services, state, logger }).catch((err) => {
      logger.fatal({ err }, 'Startup failed after connecting to Discord');
      void shutdown(1);
    });
  });
  client.on(Events.InteractionCreate, createInteractionHandler({ ...container, logger }));
  client.on(Events.Error, (err) => logger.error({ err }, 'Discord client error'));
  client.on(Events.Warn, (msg) => logger.warn({ msg }, 'Discord client warning'));

  const api = await createApiServer({ env, logger, container, startedAt });
  await api.listen({ host: env.HOST, port: env.PORT });

  let shuttingDown = false;
  async function shutdown(code = 0): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('Shutting down');
    await api.close().catch(() => {});
    await client.destroy().catch(() => {});
    dbHandle.close();
    process.exit(code);
  }
  process.on('SIGINT', () => void shutdown(0));
  process.on('SIGTERM', () => void shutdown(0));
  process.on('unhandledRejection', (err) => logger.error({ err }, 'Unhandled promise rejection'));
  process.on('uncaughtException', (err) => logger.error({ err }, 'Uncaught exception'));

  try {
    await client.login(env.DISCORD_TOKEN);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/disallowed intents/i.test(msg)) {
      logger.fatal(
        'Discord refused the privileged intents. In the Developer Portal → Bot, enable "Server Members Intent" and "Message Content Intent", then restart.',
      );
    } else if (/token/i.test(msg)) {
      logger.fatal(
        'Discord rejected DISCORD_TOKEN. Reset the token in the Developer Portal → Bot and update .env.',
      );
    } else {
      logger.fatal({ err }, 'Could not log in to Discord');
    }
    await shutdown(1);
  }
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
