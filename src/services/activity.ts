import { and, desc, eq, gte, lt, sql, sum } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { activityDaily } from '../db/schema.js';
import type { VoiceChannelSnapshot } from '../discord/ports.js';
import { DAY_MS } from './members.js';
import type { SettingsService } from './settings.js';

/** Daily activity rows older than this are pruned (the dashboard shows up to a year). */
export const ACTIVITY_HISTORY_DAYS = 400;

/** UTC date key, YYYY-MM-DD. */
export const dateKey = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** First date (inclusive) of a rolling window of `days` days ending today. */
export const windowStartKey = (now: number, days: number): string => dateKey(now - (days - 1) * DAY_MS);

/**
 * Who earns a voice minute right now. Excludes the AFK channel, bots, people alone with no other
 * human, and (unless configured otherwise) self-deafened members.
 */
export function eligibleVoiceUsers(
  snapshot: VoiceChannelSnapshot[],
  opts: { afkChannelId: string | null; countSelfDeafened: boolean },
): string[] {
  const out: string[] = [];
  for (const ch of snapshot) {
    if (ch.channelId === opts.afkChannelId) continue;
    const humans = ch.members.filter((m) => !m.isBot);
    if (humans.length < 2) continue;
    for (const m of humans) {
      if (m.selfDeaf && !opts.countSelfDeafened) continue;
      out.push(m.userId);
    }
  }
  return out;
}

export interface ActivityTotals {
  messagePoints: number;
  voiceMinutes: number;
  score: number;
}

export interface ActivityDeps {
  db: Db;
  guildId: string;
  settings: SettingsService;
  /** Current tier activity thresholds (for "crossed a threshold" detection). */
  thresholds: () => number[];
  /** Called when a member's rolling score crosses a tier threshold. */
  onThresholdCrossed: (userId: string) => void;
  now?: () => number;
}

/**
 * Activity scoring. Never stores message content: only a per-day count of messages that earned a
 * point (after the cooldown) and voice minutes. Weights are applied when scores are read, so
 * changing them re-scores history.
 */
export class ActivityService {
  private readonly lastAward = new Map<string, number>();
  private readonly now: () => number;

  constructor(private readonly d: ActivityDeps) {
    this.now = d.now ?? Date.now;
  }

  private weights() {
    const a = this.d.settings.get().activity;
    return { msg: a.pointsPerMessage, voice: a.pointsPerVoiceMinute, windowDays: a.windowDays };
  }

  /** A member sent a message. Returns true if it earned a point. */
  recordMessage(userId: string): boolean {
    const now = this.now();
    const cooldownMs = this.d.settings.get().activity.messageCooldownSeconds * 1000;
    const last = this.lastAward.get(userId);
    if (last !== undefined && now - last < cooldownMs) return false;
    this.lastAward.set(userId, now);
    this.add(userId, dateKey(now), 1, 0);
    this.checkCrossing(userId, this.weights().msg);
    return true;
  }

  /** Award one voice minute to everyone eligible. Run once per minute. Returns who earned it. */
  voiceTick(snapshot: VoiceChannelSnapshot[], afkChannelId: string | null): string[] {
    const users = eligibleVoiceUsers(snapshot, {
      afkChannelId,
      countSelfDeafened: this.d.settings.get().activity.countSelfDeafened,
    });
    const day = dateKey(this.now());
    const delta = this.weights().voice;
    this.d.db.transaction(() => {
      for (const u of users) this.add(u, day, 0, 1);
    });
    for (const u of users) this.checkCrossing(u, delta);
    return users;
  }

  private add(userId: string, date: string, messages: number, minutes: number): void {
    this.d.db
      .insert(activityDaily)
      .values({ guildId: this.d.guildId, userId, date, messagePoints: messages, voiceMinutes: minutes })
      .onConflictDoUpdate({
        target: [activityDaily.guildId, activityDaily.userId, activityDaily.date],
        set: {
          messagePoints: sql`${activityDaily.messagePoints} + ${messages}`,
          voiceMinutes: sql`${activityDaily.voiceMinutes} + ${minutes}`,
        },
      })
      .run();
  }

  private checkCrossing(userId: string, delta: number): void {
    if (delta <= 0) return;
    const after = this.totals(userId).score;
    const before = after - delta;
    if (this.d.thresholds().some((t) => t > 0 && before < t && after >= t)) this.d.onThresholdCrossed(userId);
  }

  /** Rolling-window totals for one member. */
  totals(userId: string, now = this.now()): ActivityTotals {
    const w = this.weights();
    const row = this.d.db
      .select({ m: sum(activityDaily.messagePoints), v: sum(activityDaily.voiceMinutes) })
      .from(activityDaily)
      .where(
        and(
          eq(activityDaily.guildId, this.d.guildId),
          eq(activityDaily.userId, userId),
          gte(activityDaily.date, windowStartKey(now, w.windowDays)),
        ),
      )
      .get();
    const messagePoints = Number(row?.m ?? 0);
    const voiceMinutes = Number(row?.v ?? 0);
    return { messagePoints, voiceMinutes, score: messagePoints * w.msg + voiceMinutes * w.voice };
  }

  /** Rolling-window totals for everyone with activity, highest score first. */
  allTotals(now = this.now()): (ActivityTotals & { userId: string })[] {
    const w = this.weights();
    const rows = this.d.db
      .select({
        userId: activityDaily.userId,
        m: sum(activityDaily.messagePoints),
        v: sum(activityDaily.voiceMinutes),
      })
      .from(activityDaily)
      .where(
        and(
          eq(activityDaily.guildId, this.d.guildId),
          gte(activityDaily.date, windowStartKey(now, w.windowDays)),
        ),
      )
      .groupBy(activityDaily.userId)
      .all();
    return rows
      .map((r) => {
        const messagePoints = Number(r.m ?? 0);
        const voiceMinutes = Number(r.v ?? 0);
        return {
          userId: r.userId,
          messagePoints,
          voiceMinutes,
          score: messagePoints * w.msg + voiceMinutes * w.voice,
        };
      })
      .sort((a, b) => b.score - a.score);
  }

  /** Daily rows for a member (for charts), oldest first. */
  history(userId: string, days = 90, now = this.now()) {
    return this.d.db
      .select()
      .from(activityDaily)
      .where(
        and(
          eq(activityDaily.guildId, this.d.guildId),
          eq(activityDaily.userId, userId),
          gte(activityDaily.date, windowStartKey(now, days)),
        ),
      )
      .orderBy(desc(activityDaily.date))
      .all()
      .reverse();
  }

  prune(now = this.now()): number {
    return this.d.db
      .delete(activityDaily)
      .where(
        and(
          eq(activityDaily.guildId, this.d.guildId),
          lt(activityDaily.date, windowStartKey(now, ACTIVITY_HISTORY_DAYS)),
        ),
      )
      .run().changes;
  }
}
