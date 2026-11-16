import { and, eq, isNull } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { members } from '../db/schema.js';
import type { MemberInfo } from '../discord/ports.js';
import type { SettingsService } from './settings.js';

export type MemberRow = typeof members.$inferSelect;

export const DAY_MS = 86_400_000;

/** A join that differs from the stored one by more than this is treated as an unobserved rejoin. */
const REJOIN_TOLERANCE_MS = 60_000;

export function tenureDays(joinedAt: Date, now = Date.now()): number {
  return Math.max(0, Math.floor((now - joinedAt.getTime()) / DAY_MS));
}

type Profile = Pick<MemberInfo, 'userId' | 'username' | 'displayName' | 'avatarUrl' | 'isBot'>;

/**
 * Tracks membership for tenure: first join ever seen, the join date used for tenure (reset on
 * rejoin when configured), and when someone left.
 */
export class MemberService {
  constructor(
    private readonly db: Db,
    private readonly guildId: string,
    private readonly settings: SettingsService,
  ) {}

  get(userId: string): MemberRow | undefined {
    return this.db
      .select()
      .from(members)
      .where(and(eq(members.guildId, this.guildId), eq(members.userId, userId)))
      .get();
  }

  /** Current (not left) members. */
  listCurrent(): MemberRow[] {
    return this.db
      .select()
      .from(members)
      .where(and(eq(members.guildId, this.guildId), isNull(members.leftAt)))
      .all();
  }

  /**
   * Record a join, seen live (memberAdd) or during backfill. `joinedAt` is Discord's join date,
   * which is always the most recent join.
   */
  recordJoin(profile: Profile, joinedAt: Date, now = new Date()): 'new' | 'rejoin' | 'existing' {
    const existing = this.get(profile.userId);
    const base = {
      username: profile.username,
      displayName: profile.displayName,
      avatar: profile.avatarUrl,
      isBot: profile.isBot,
      updatedAt: now,
    };
    if (!existing) {
      this.db
        .insert(members)
        .values({
          guildId: this.guildId,
          userId: profile.userId,
          ...base,
          firstJoinedAt: joinedAt,
          joinedAt,
          leftAt: null,
        })
        .run();
      return 'new';
    }
    const unobservedRejoin = joinedAt.getTime() - existing.joinedAt.getTime() > REJOIN_TOLERANCE_MS;
    const isRejoin = existing.leftAt !== null || unobservedRejoin;
    const reset = this.settings.get().tenure.resetOnRejoin;
    const firstJoinedAt = joinedAt < existing.firstJoinedAt ? joinedAt : existing.firstJoinedAt;
    this.db
      .update(members)
      .set({
        ...base,
        firstJoinedAt,
        joinedAt: isRejoin ? (reset ? joinedAt : existing.joinedAt) : existing.joinedAt,
        leftAt: null,
      })
      .where(and(eq(members.guildId, this.guildId), eq(members.userId, profile.userId)))
      .run();
    return isRejoin ? 'rejoin' : 'existing';
  }

  recordLeave(userId: string, at = new Date()): void {
    this.db
      .update(members)
      .set({ leftAt: at, updatedAt: at })
      .where(and(eq(members.guildId, this.guildId), eq(members.userId, userId)))
      .run();
  }

  updateProfile(profile: Profile, now = new Date()): void {
    this.db
      .update(members)
      .set({
        username: profile.username,
        displayName: profile.displayName,
        avatar: profile.avatarUrl,
        updatedAt: now,
      })
      .where(and(eq(members.guildId, this.guildId), eq(members.userId, profile.userId)))
      .run();
  }

  /**
   * Reconcile the table with the live member list: add new members (backfilling from Discord's
   * joinedAt), detect rejoins, and mark people who left while the bot was offline.
   */
  syncAll(live: MemberInfo[], now = new Date()): { added: number; rejoined: number; left: number } {
    let added = 0;
    let rejoined = 0;
    let left = 0;
    const liveIds = new Set<string>();
    this.db.transaction(() => {
      for (const m of live) {
        liveIds.add(m.userId);
        const r = this.recordJoin(m, m.joinedAt ?? now, now);
        if (r === 'new') added++;
        else if (r === 'rejoin') rejoined++;
      }
      for (const row of this.listCurrent()) {
        if (!liveIds.has(row.userId)) {
          this.recordLeave(row.userId, now);
          left++;
        }
      }
    });
    return { added, rejoined, left };
  }

  tenureDaysFor(userId: string, now = Date.now()): number | null {
    const row = this.get(userId);
    return row ? tenureDays(row.joinedAt, now) : null;
  }
}
