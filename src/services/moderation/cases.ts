import { and, desc, eq, lt, max, type SQL } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { type ModAction, type ModSource, modCases } from '../../db/schema.js';
import { formatDuration } from '../../shared/commandOptions.js';
import { COLORS, type ResultEmbed } from '../../shared/commandResult.js';

export type ModCase = typeof modCases.$inferSelect;

export interface NewCase {
  action: ModAction;
  targetId: string;
  moderatorId: string;
  reason?: string | null;
  durationMs?: number | null;
  expiresAt?: Date | null;
  source: ModSource;
  data?: Record<string, unknown> | null;
}

export const ACTION_LABELS: Record<ModAction, string> = {
  ban: 'Ban',
  unban: 'Unban',
  kick: 'Kick',
  timeout: 'Timeout',
  untimeout: 'Timeout removed',
  warn: 'Warning',
  purge: 'Purge',
  role_add: 'Role added',
  role_remove: 'Role removed',
  nick: 'Nickname changed',
  slowmode: 'Slowmode',
  lock: 'Channel locked',
  unlock: 'Channel unlocked',
};

const ACTION_COLORS: Partial<Record<ModAction, number>> = {
  ban: COLORS.danger,
  kick: 0xe67e22,
  timeout: COLORS.warning,
  warn: COLORS.warning,
  unban: COLORS.success,
  untimeout: COLORS.success,
  unlock: COLORS.success,
  lock: COLORS.warning,
};

/** Channel-targeted actions mention a channel rather than a user. */
const CHANNEL_ACTIONS = new Set<ModAction>(['slowmode', 'lock', 'unlock']);

/** Persistence for moderation cases. Case numbers are sequential per guild. */
export class CaseStore {
  constructor(
    private readonly db: Db,
    private readonly guildId: string,
  ) {}

  create(input: NewCase): ModCase {
    // better-sqlite3 is synchronous, so read-max-then-insert inside a transaction is race-free.
    return this.db.transaction((tx) => {
      const row = tx
        .select({ n: max(modCases.caseNumber) })
        .from(modCases)
        .where(eq(modCases.guildId, this.guildId))
        .get();
      const caseNumber = (row?.n ?? 0) + 1;
      return tx
        .insert(modCases)
        .values({
          guildId: this.guildId,
          caseNumber,
          action: input.action,
          targetId: input.targetId,
          moderatorId: input.moderatorId,
          reason: input.reason ?? null,
          durationMs: input.durationMs ?? null,
          expiresAt: input.expiresAt ?? null,
          source: input.source,
          data: input.data ?? null,
          createdAt: new Date(),
        })
        .returning()
        .get();
    });
  }

  get(caseNumber: number): ModCase | undefined {
    return this.db
      .select()
      .from(modCases)
      .where(and(eq(modCases.guildId, this.guildId), eq(modCases.caseNumber, caseNumber)))
      .get();
  }

  setLogMessage(id: number, messageId: string | null): void {
    if (!messageId) return;
    this.db.update(modCases).set({ logMessageId: messageId }).where(eq(modCases.id, id)).run();
  }

  setActive(id: number, active: boolean): void {
    this.db.update(modCases).set({ active }).where(eq(modCases.id, id)).run();
  }

  list(
    opts: {
      targetId?: string;
      action?: ModAction;
      moderatorId?: string;
      activeOnly?: boolean;
      beforeId?: number;
      limit?: number;
    } = {},
  ): ModCase[] {
    const where: SQL[] = [eq(modCases.guildId, this.guildId)];
    if (opts.targetId) where.push(eq(modCases.targetId, opts.targetId));
    if (opts.action) where.push(eq(modCases.action, opts.action));
    if (opts.moderatorId) where.push(eq(modCases.moderatorId, opts.moderatorId));
    if (opts.activeOnly) where.push(eq(modCases.active, true));
    if (opts.beforeId) where.push(lt(modCases.id, opts.beforeId));
    return this.db
      .select()
      .from(modCases)
      .where(and(...where))
      .orderBy(desc(modCases.id))
      .limit(Math.min(opts.limit ?? 50, 500))
      .all();
  }

  /** Most recent case of an action for a target (e.g. the last lock on a channel). */
  latest(action: ModAction, targetId: string): ModCase | undefined {
    return this.list({ action, targetId, limit: 1 })[0];
  }
}

export function isChannelTarget(c: Pick<ModCase, 'action' | 'data'>): boolean {
  return CHANNEL_ACTIONS.has(c.action) || c.data?.targetType === 'channel';
}

export function targetMention(c: Pick<ModCase, 'action' | 'targetId' | 'data'>): string {
  return isChannelTarget(c) ? `<#${c.targetId}>` : `<@${c.targetId}>`;
}

const ts = (d: Date, style: 'R' | 'f' = 'R') => `<t:${Math.floor(d.getTime() / 1000)}:${style}>`;

/** Embed used for the moderation log and for /case. */
export function caseEmbed(c: ModCase): ResultEmbed {
  const fields: ResultEmbed['fields'] = [
    { name: isChannelTarget(c) ? 'Channel' : 'Target', value: `${targetMention(c)}`, inline: true },
    {
      name: 'Moderator',
      value: c.source === 'system' ? 'System' : `<@${c.moderatorId}>`,
      inline: true,
    },
    { name: 'Source', value: c.source, inline: true },
  ];
  if (c.reason) fields.push({ name: 'Reason', value: c.reason });
  if (c.durationMs) fields.push({ name: 'Duration', value: formatDuration(c.durationMs), inline: true });
  if (c.expiresAt) fields.push({ name: 'Expires', value: ts(c.expiresAt), inline: true });
  const d = c.data ?? {};
  if (typeof d.roleId === 'string') fields.push({ name: 'Role', value: `<@&${d.roleId}>`, inline: true });
  if (c.action === 'nick') {
    fields.push({ name: 'Before', value: String(d.before ?? '(none)'), inline: true });
    fields.push({ name: 'After', value: String(d.after ?? '(reset)'), inline: true });
  }
  if (c.action === 'purge') {
    fields.push({
      name: 'Result',
      value: `${d.deleted ?? 0} deleted, ${d.skippedOld ?? 0} too old, ${d.scanned ?? 0} scanned in <#${d.channelId}>`,
    });
  }
  if (c.action === 'slowmode') {
    fields.push({ name: 'Interval', value: d.seconds ? `${d.seconds}s` : 'off', inline: true });
  }
  if (c.action === 'warn' && !c.active) fields.push({ name: 'Status', value: 'Removed', inline: true });
  return {
    title: `Case #${c.caseNumber} • ${ACTION_LABELS[c.action]}`,
    color: ACTION_COLORS[c.action] ?? COLORS.info,
    fields,
    footer: `Target ID: ${c.targetId} • Moderator ID: ${c.moderatorId}`,
    timestamp: c.createdAt.toISOString(),
  };
}
