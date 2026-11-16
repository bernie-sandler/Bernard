import type { Db } from '../db/client.js';
import type { BotInfoPort, GuildPort, MessengerPort } from '../discord/ports.js';
import type { Logger } from '../logger.js';
import { AuditService } from './audit.js';
import { CommandExecutor } from './commands/executor.js';
import { CommandRegistry } from './commands/registry.js';
import type { CommandDefinition } from './commands/types.js';
import { LogService } from './logs.js';
import { PermissionService } from './permissions/service.js';
import { SettingsService } from './settings.js';

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
  registry: CommandRegistry;
}

export interface ContainerDeps {
  db: Db;
  logger: Logger;
  guild: GuildPort;
  messenger: MessengerPort;
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
    registry,
  };
  return { services, executor: new CommandExecutor(services, logger) };
}
