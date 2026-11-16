/**
 * Map Discord audit log entries for moderation done outside the bot (right-click → Ban, etc.)
 * to mod cases. Pure, so it can be unit-tested without discord.js.
 */

/** Discord audit log action types we care about (values from the Discord API). */
export const AUDIT = {
  MemberKick: 20,
  MemberBanAdd: 22,
  MemberBanRemove: 23,
  MemberUpdate: 24,
} as const;

export interface AuditEntryLike {
  action: number;
  executorId: string | null;
  targetId: string | null;
  reason: string | null;
  changes: { key: string; old?: unknown; new?: unknown }[];
  createdAt: Date;
}

export interface ExternalModAction {
  action: 'ban' | 'unban' | 'kick' | 'timeout' | 'untimeout';
  targetId: string;
  moderatorId: string;
  reason: string | null;
  durationMs: number | null;
}

export function mapAuditEntry(entry: AuditEntryLike, botUserId: string | null): ExternalModAction | null {
  if (!entry.executorId || !entry.targetId) return null;
  // Actions the bot performed itself are already recorded by ModerationService.
  if (botUserId && entry.executorId === botUserId) return null;
  const base = {
    targetId: entry.targetId,
    moderatorId: entry.executorId,
    reason: entry.reason,
    durationMs: null,
  };
  switch (entry.action) {
    case AUDIT.MemberBanAdd:
      return { ...base, action: 'ban' };
    case AUDIT.MemberBanRemove:
      return { ...base, action: 'unban' };
    case AUDIT.MemberKick:
      return { ...base, action: 'kick' };
    case AUDIT.MemberUpdate: {
      const change = entry.changes.find((c) => c.key === 'communication_disabled_until');
      if (!change) return null;
      if (change.new) {
        const until = new Date(String(change.new)).getTime();
        if (Number.isNaN(until)) return null;
        return { ...base, action: 'timeout', durationMs: Math.max(0, until - entry.createdAt.getTime()) };
      }
      return change.old ? { ...base, action: 'untimeout' } : null;
    }
    default:
      return null;
  }
}
