import type { Db } from '../db/client.js';
import type { BotInfoPort, GuildPort, MessengerPort, ModerationPort, VoicePort } from '../discord/ports.js';
import type { Logger } from '../logger.js';
import { AuditService } from './audit.js';
import { CommandExecutor } from './commands/executor.js';
import { CommandRegistry } from './commands/registry.js';
import type { CommandDefinition } from './commands/types.js';
import { EventLogService } from './eventLog.js';
import { LogService } from './logs.js';
import { MessageCache } from './messageCache.js';
import { ModerationService } from './moderation/service.js';
import { PermissionService } from './permissions/service.js';
import { SettingsService } from './settings.js';
import { VoiceService } from './voice.js';

/** Everything commands and API routes can reach. */
export interface Services {
  db: Db;
  logger: Logger;
  guild: GuildPort;
  messenger: MessengerPort;
  bot: BotInfoPort;
  audit: AuditService;
  settings: SettingsService;
  permissions: PermissionService;
  logs: LogService;
  eventLog: EventLogService;
  messageCache: MessageCache;
  moderation: ModerationService;
  voice: VoiceService;
  registry: CommandRegistry;
}

export interface ContainerDeps {
  db: Db;
  logger: Logger;
  guild: GuildPort;
  messenger: MessengerPort;
  mod: ModerationPort;
  voice: VoicePort;
  bot: BotInfoPort;
  commands: CommandDefinition[];
}

export interface Container {
  services: Services;
  executor: CommandExecutor;
}

export function createContainer(deps: ContainerDeps): Container {
  const { db, logger, guild } = deps;
  const guildId = guild.guildId;
  const registry = new CommandRegistry(deps.commands);
  const audit = new AuditService(db, guildId);
  const settings = new SettingsService(db, guildId, audit, logger);
  const permissions = new PermissionService(db, guildId, settings, audit, () => registry);
  const logs = new LogService(db, guildId, settings, deps.messenger, logger);
  const eventLog = new EventLogService(logs, settings);
  const messageCache = new MessageCache(settings.get().logs.messageCacheSize);
  settings.onChange((next) => messageCache.resize(next.logs.messageCacheSize));
  const moderation = new ModerationService({
    db,
    guildId,
    guild,
    mod: deps.mod,
    logs,
    settings,
    bot: deps.bot,
    logger,
  });

  const voice = new VoiceService({ db, guildId, voice: deps.voice, guild, settings, audit, logger });

  const services: Services = {
    db,
    logger,
    guild,
    messenger: deps.messenger,
    bot: deps.bot,
    audit,
    settings,
    permissions,
    logs,
    eventLog,
    messageCache,
    moderation,
    voice,
    registry,
  };
  return { services, executor: new CommandExecutor(services, logger) };
}
