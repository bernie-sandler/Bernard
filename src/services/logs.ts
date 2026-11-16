import { lt } from 'drizzle-orm';
import type { LogType } from '../config/settings.js';
import type { Db } from '../db/client.js';
import { logs } from '../db/schema.js';
import type { MessengerPort } from '../discord/ports.js';
import type { Logger } from '../logger.js';
import { COLORS, type ResultEmbed } from '../shared/commandResult.js';
import type { LiveEvents } from './liveEvents.js';
import type { SettingsService } from './settings.js';

export interface LogEntryInput {
  type: LogType;
  event: string;
  actorId?: string | null;
  targetId?: string | null;
  channelId?: string | null;
  summary: string;
  data?: Record<string, unknown>;
  /** Embed to post in the routed channel; a plain one is built from `summary` if omitted. */
  embed?: ResultEmbed;
}

/** Writes log entries to the DB and posts them to the configured channel for their type. */
export class LogService {
  constructor(
    private readonly db: Db,
    private readonly guildId: string,
    private readonly settings: SettingsService,
    private readonly messenger: MessengerPort,
    private readonly logger: Logger,
    private readonly live?: LiveEvents,
  ) {}

  /** Store the entry and post it. Resolves with the posted message ID (null if not posted). */
  async record(entry: LogEntryInput): Promise<{ messageId: string | null }> {
    const createdAt = new Date();
    try {
      this.db
        .insert(logs)
        .values({
          guildId: this.guildId,
          type: entry.type,
          event: entry.event,
          actorId: entry.actorId ?? null,
          targetId: entry.targetId ?? null,
          channelId: entry.channelId ?? null,
          summary: entry.summary,
          data: entry.data ?? null,
          createdAt,
        })
        .run();
    } catch (err) {
      this.logger.error(
        { err, entry: { type: entry.type, event: entry.event } },
        'Failed to store log entry',
      );
    }
    this.live?.publish(entry.type);

    const channelId = this.settings.get().logs.channels[entry.type];
    if (!channelId) return { messageId: null };
    const embed: ResultEmbed = {
      color: COLORS.neutral,
      description: entry.summary,
      ...entry.embed,
      timestamp: createdAt.toISOString(),
      footer: entry.embed?.footer ?? idFooter(entry),
    };
    try {
      return { messageId: await this.messenger.sendEmbed(channelId, embed) };
    } catch (err) {
      this.logger.warn({ err, channelId, type: entry.type }, 'Failed to post log entry to channel');
      return { messageId: null };
    }
  }

  /** Delete stored entries older than the retention period. Returns rows removed. */
  prune(now = new Date()): number {
    const days = this.settings.get().logs.retentionDays;
    const cutoff = new Date(now.getTime() - days * 86_400_000);
    return this.db.delete(logs).where(lt(logs.createdAt, cutoff)).run().changes;
  }
}

function idFooter(e: LogEntryInput): string {
  const parts: string[] = [];
  if (e.actorId) parts.push(`Actor: ${e.actorId}`);
  if (e.targetId && e.targetId !== e.actorId) parts.push(`Target: ${e.targetId}`);
  return parts.join(' • ') || e.event;
}
