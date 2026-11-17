import type { Db } from '../db/client.js';
import type { BotInfoPort, GuildPort, MessengerPort, ModerationPort, VoicePort } from '../discord/ports.js';
import type { Logger } from '../logger.js';
import { ActivityService } from './activity.js';
import { AuditService } from './audit.js';
import type { BelltowerClient } from './belltower/client.js';
import { BelltowerService } from './belltower/service.js';
import { BotStateStore } from './botState.js';
import { CommandExecutor } from './commands/executor.js';
import { CommandRegistry } from './commands/registry.js';
import type { CommandDefinition } from './commands/types.js';
import { EventLogService } from './eventLog.js';
import { LiveEvents } from './liveEvents.js';
import { LogService } from './logs.js';
import { MemberService } from './members.js';
import { MessageCache } from './messageCache.js';
import { ModerationService } from './moderation/service.js';
import { PermissionService } from './permissions/service.js';
import { RolePanelService } from './rolePanels.js';
import { SessionService } from './sessions.js';
import { SettingsService } from './settings.js';
import { HttpKumaClient, type KumaClient } from './status/kuma.js';
import { StatusService } from './status/service.js';
import { TierService } from './tiers.js';
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
  members: MemberService;
  activity: ActivityService;
  tiers: TierService;
  status: StatusService;
  rolePanels: RolePanelService;
  belltower: BelltowerService;
  state: BotStateStore;
  sessions: SessionService;
  live: LiveEvents;
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
  /** Uptime Kuma client (default: real HTTP). */
  kuma?: KumaClient;
  /** Belltower client; null or omitted when BELLTOWER_URL / BELLTOWER_TOKEN aren't set. */
  belltower?: BelltowerClient | null;
  /** Dashboard session lifetime (default 7 days). */
  sessionTtlMs?: number;
}

export interface Container {
  services: Services;
  executor: CommandExecutor;
}

export function createContainer(deps: ContainerDeps): Container {
  const { db, logger, guild } = deps;
  const guildId = guild.guildId;
  const registry = new CommandRegistry(deps.commands);
  const live = new LiveEvents();
  const audit = new AuditService(db, guildId, live);
  const settings = new SettingsService(db, guildId, audit, logger);
  const permissions = new PermissionService(db, guildId, settings, audit, () => registry);
  const logs = new LogService(db, guildId, settings, deps.messenger, logger, live);
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

  const voice = new VoiceService({ db, guildId, voice: deps.voice, guild, settings, audit, logger, live });
  const state = new BotStateStore(db, guildId);
  const sessions = new SessionService(db, guildId, deps.sessionTtlMs ?? 7 * 86_400_000);
  const members = new MemberService(db, guildId, settings);
  // Activity and tiers reference each other (thresholds / crossing callback), so wire them lazily.
  let tiers: TierService | null = null;
  const activity = new ActivityService({
    db,
    guildId,
    settings,
    thresholds: () => tiers?.list().map((t) => t.minActivity) ?? [],
    onThresholdCrossed: (userId) => tiers?.queueEvaluate(userId),
  });
  tiers = new TierService({
    db,
    guildId,
    guild,
    mod: deps.mod,
    settings,
    audit,
    eventLog,
    activity,
    members,
    state,
    logger,
    live,
  });

  const status = new StatusService({
    guild,
    messenger: deps.messenger,
    kuma: deps.kuma ?? new HttpKumaClient(),
    settings,
    state,
    logger,
    live,
  });
  const rolePanels = new RolePanelService({
    db,
    guildId,
    guild,
    mod: deps.mod,
    messenger: deps.messenger,
    audit,
    logger,
  });

  const belltower = new BelltowerService({
    db,
    guildId,
    guild,
    mod: deps.mod,
    messenger: deps.messenger,
    settings,
    state,
    status,
    client: deps.belltower ?? null,
    logger,
    live,
  });

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
    members,
    activity,
    tiers,
    status,
    rolePanels,
    belltower,
    state,
    sessions,
    live,
    registry,
  };
  return { services, executor: new CommandExecutor(services, logger) };
}
