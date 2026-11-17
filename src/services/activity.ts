import { and, desc, eq, gte, lt, sql, sum } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { activityDaily } from '../db/schema.js';
import type { VoiceChannelSnapshot } from '../discord/ports.js';
import type { ActivityCounts, ActivityPoints } from '../shared/api.js';
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

export interface ActivityTotals extends ActivityCounts {
  score: number;
}

/** Each kind has its own cooldown, so one message can earn the message point and both bonuses. */
export type ActivityKind = 'message' | 'image' | 'link' | 'reaction';

export interface ActivityWeights {
  message: number;
  voice: number;
  /** Multiplier for voice minutes past the long-session threshold. */
  voiceLongMultiplier: number;
  image: number;
  link: number;
  reaction: number;
  reactionReceived: number;
}

const EMPTY_COUNTS: ActivityCounts = {
  messagePoints: 0,
  voiceMinutes: 0,
  images: 0,
  links: 0,
  reactions: 0,
  reactionsReceived: 0,
  voiceLongMinutes: 0,
};

/**
 * A voice session survives gaps up to this long (reconnects, briefly being alone), so a dropped
 * connection doesn't restart it.
 */
export const VOICE_SESSION_GAP_MS = 5 * 60_000;

export function activityPoints(c: ActivityCounts, w: ActivityWeights): ActivityPoints {
  const longMinutes = Math.min(c.voiceLongMinutes, c.voiceMinutes);
  return {
    messages: c.messagePoints * w.message,
    voice: (c.voiceMinutes - longMinutes) * w.voice + longMinutes * w.voice * w.voiceLongMultiplier,
    images: c.images * w.image,
    links: c.links * w.link,
    reactions: c.reactions * w.reaction,
    reactionsReceived: c.reactionsReceived * w.reactionReceived,
  };
}

export function activityScore(c: ActivityCounts, w: ActivityWeights): number {
  const p = activityPoints(c, w);
  return p.messages + p.voice + p.images + p.links + p.reactions + p.reactionsReceived;
}

const sums = {
  m: sum(activityDaily.messagePoints),
  v: sum(activityDaily.voiceMinutes),
  vl: sum(activityDaily.voiceLongMinutes),
  i: sum(activityDaily.imageCount),
  l: sum(activityDaily.linkCount),
  r: sum(activityDaily.reactionCount),
  rr: sum(activityDaily.reactionsReceivedCount),
};

type SumRow = { [K in keyof typeof sums]: string | null };

const toCounts = (row: SumRow | undefined): ActivityCounts => ({
  messagePoints: Number(row?.m ?? 0),
  voiceMinutes: Number(row?.v ?? 0),
  images: Number(row?.i ?? 0),
  links: Number(row?.l ?? 0),
  reactions: Number(row?.r ?? 0),
  reactionsReceived: Number(row?.rr ?? 0),
  voiceLongMinutes: Number(row?.vl ?? 0),
});

export interface ReactionEvent {
  reactorId: string;
  /** The message author, or null when it's a bot, webhook or system message. */
  authorId: string | null;
  messageId: string;
  /** When the message was posted (ms). */
  messageCreatedAt: number;
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
 * Activity scoring. Never stores message content: only per-day counts of messages, image and link
 * bonuses, reactions given and received that earned points, plus voice minutes (and how many of
 * them came after the long-session threshold). Weights are
 * applied when scores are read, so changing them re-scores history.
 */
export class ActivityService {
  /** Last award time per `kind:userId`. */
  private readonly lastAward = new Map<string, number>();
  /** Continuous voice minutes per member and when they last earned one. */
  private readonly voiceStreak = new Map<string, { minutes: number; lastTick: number }>();
  /** Reactors already counted per recent message, with the message's posting time. */
  private readonly messageReactors = new Map<string, { createdAt: number; reactors: Set<string> }>();
  /** When a member recently received point-earning reactions (for the grace threshold). */
  private readonly receivedTimes = new Map<string, number[]>();
  /** End of a member's reaction grace period. */
  private readonly graceUntil = new Map<string, number>();
  private readonly now: () => number;

  constructor(private readonly d: ActivityDeps) {
    this.now = d.now ?? Date.now;
  }

  weights(): ActivityWeights {
    const a = this.d.settings.get().activity;
    return {
      message: a.pointsPerMessage,
      voice: a.pointsPerVoiceMinute,
      voiceLongMultiplier: a.voiceLongSessionMultiplier,
      image: a.pointsPerImage,
      link: a.pointsPerLink,
      reaction: a.pointsPerReaction,
      reactionReceived: a.pointsPerReactionReceived,
    };
  }

  private windowDays(): number {
    return this.d.settings.get().activity.windowDays;
  }

  /** Returns true (and starts the cooldown) if `kind` can earn for this member now. */
  private claim(kind: ActivityKind, userId: string, now: number): boolean {
    const cooldownMs = this.d.settings.get().activity.messageCooldownSeconds * 1000;
    const key = `${kind}:${userId}`;
    const last = this.lastAward.get(key);
    if (last !== undefined && now - last < cooldownMs) return false;
    this.lastAward.set(key, now);
    return true;
  }

  /**
   * A member sent a message. It earns the message point, plus the image and link bonuses when it
   * has them, each with its own cooldown. Returns the kinds that earned.
   */
  recordMessage(userId: string, has: { image?: boolean; link?: boolean } = {}): ActivityKind[] {
    const now = this.now();
    const earned: ActivityKind[] = [];
    if (this.claim('message', userId, now)) earned.push('message');
    if (has.image && this.claim('image', userId, now)) earned.push('image');
    if (has.link && this.claim('link', userId, now)) earned.push('link');
    if (earned.length > 0) {
      this.award(userId, now, {
        ...EMPTY_COUNTS,
        messagePoints: earned.includes('message') ? 1 : 0,
        images: earned.includes('image') ? 1 : 0,
        links: earned.includes('link') ? 1 : 0,
      });
    }
    return earned;
  }

  /**
   * A member reacted to a message. The reactor earns the (cooldown-limited) reaction point. The
   * author earns a received point if the reaction came within the window after posting and this
   * reactor hasn't already counted on the message. Nobody earns reaction points during their grace
   * period, and reacting to your own message earns nothing.
   */
  recordReaction(e: ReactionEvent): { given: boolean; received: boolean } {
    const now = this.now();
    if (e.authorId === e.reactorId) return { given: false, received: false };
    const given = !this.inGrace(e.reactorId, now) && this.claim('reaction', e.reactorId, now);
    if (given) this.award(e.reactorId, now, { ...EMPTY_COUNTS, reactions: 1 });
    const author = e.authorId;
    const received = author !== null && this.claimReceived(author, e, now);
    if (received) this.award(author, now, { ...EMPTY_COUNTS, reactionsReceived: 1 });
    return { given, received };
  }

  /** End of the member's reaction grace period (ms), or null when they aren't in one. */
  reactionGraceUntil(userId: string, now = this.now()): number | null {
    return this.inGrace(userId, now) ? (this.graceUntil.get(userId) ?? null) : null;
  }

  private inGrace(userId: string, now: number): boolean {
    const until = this.graceUntil.get(userId);
    if (until === undefined) return false;
    if (now < until) return true;
    this.graceUntil.delete(userId);
    return false;
  }

  private claimReceived(authorId: string, e: ReactionEvent, now: number): boolean {
    const a = this.d.settings.get().activity;
    const windowMs = a.reactionReceiveWindowMinutes * 60_000;
    this.pruneMessages(now, windowMs);
    if (now - e.messageCreatedAt > windowMs || this.inGrace(authorId, now)) return false;
    let entry = this.messageReactors.get(e.messageId);
    if (!entry) {
      entry = { createdAt: e.messageCreatedAt, reactors: new Set() };
      this.messageReactors.set(e.messageId, entry);
    }
    if (entry.reactors.has(e.reactorId)) return false;
    entry.reactors.add(e.reactorId);

    if (a.reactionGraceThreshold > 0) {
      const since = now - a.reactionGraceWindowMinutes * 60_000;
      const times = (this.receivedTimes.get(authorId) ?? []).filter((t) => t > since);
      times.push(now);
      if (times.length >= a.reactionGraceThreshold) {
        this.graceUntil.set(authorId, now + a.reactionGraceMinutes * 60_000);
        this.receivedTimes.delete(authorId);
      } else {
        this.receivedTimes.set(authorId, times);
      }
    }
    return true;
  }

  /** Forget messages past the receive window: reactions on them can't earn any more. */
  private pruneMessages(now: number, windowMs: number): void {
    for (const [id, m] of this.messageReactors) {
      if (now - m.createdAt > windowMs) this.messageReactors.delete(id);
    }
  }

  private award(userId: string, now: number, counts: ActivityCounts): void {
    this.add(userId, dateKey(now), counts);
    this.checkCrossing(userId, activityScore(counts, this.weights()));
  }

  /** Award one voice minute to everyone eligible. Run once per minute. Returns who earned it. */
  voiceTick(snapshot: VoiceChannelSnapshot[], afkChannelId: string | null): string[] {
    const users = eligibleVoiceUsers(snapshot, {
      afkChannelId,
      countSelfDeafened: this.d.settings.get().activity.countSelfDeafened,
    });
    const now = this.now();
    const day = dateKey(now);
    const longAfter = this.d.settings.get().activity.voiceLongSessionMinutes;
    const w = this.weights();
    const awards = users.map((userId) => {
      const prev = this.voiceStreak.get(userId);
      const minutes = prev && now - prev.lastTick <= VOICE_SESSION_GAP_MS ? prev.minutes + 1 : 1;
      this.voiceStreak.set(userId, { minutes, lastTick: now });
      const counts = { ...EMPTY_COUNTS, voiceMinutes: 1, voiceLongMinutes: minutes > longAfter ? 1 : 0 };
      return { userId, counts, delta: activityScore(counts, w) };
    });
    for (const [userId, s] of this.voiceStreak) {
      if (now - s.lastTick > VOICE_SESSION_GAP_MS) this.voiceStreak.delete(userId);
    }
    this.d.db.transaction(() => {
      for (const a of awards) this.add(a.userId, day, a.counts);
    });
    for (const a of awards) this.checkCrossing(a.userId, a.delta);
    return users;
  }

  private add(userId: string, date: string, c: ActivityCounts): void {
    this.d.db
      .insert(activityDaily)
      .values({
        guildId: this.d.guildId,
        userId,
        date,
        messagePoints: c.messagePoints,
        voiceMinutes: c.voiceMinutes,
        imageCount: c.images,
        linkCount: c.links,
        reactionCount: c.reactions,
        voiceLongMinutes: c.voiceLongMinutes,
        reactionsReceivedCount: c.reactionsReceived,
      })
      .onConflictDoUpdate({
        target: [activityDaily.guildId, activityDaily.userId, activityDaily.date],
        set: {
          messagePoints: sql`${activityDaily.messagePoints} + ${c.messagePoints}`,
          voiceMinutes: sql`${activityDaily.voiceMinutes} + ${c.voiceMinutes}`,
          imageCount: sql`${activityDaily.imageCount} + ${c.images}`,
          linkCount: sql`${activityDaily.linkCount} + ${c.links}`,
          reactionCount: sql`${activityDaily.reactionCount} + ${c.reactions}`,
          voiceLongMinutes: sql`${activityDaily.voiceLongMinutes} + ${c.voiceLongMinutes}`,
          reactionsReceivedCount: sql`${activityDaily.reactionsReceivedCount} + ${c.reactionsReceived}`,
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
    const row = this.d.db
      .select(sums)
      .from(activityDaily)
      .where(
        and(
          eq(activityDaily.guildId, this.d.guildId),
          eq(activityDaily.userId, userId),
          gte(activityDaily.date, windowStartKey(now, this.windowDays())),
        ),
      )
      .get();
    const counts = toCounts(row);
    return { ...counts, score: activityScore(counts, this.weights()) };
  }

  /** Rolling-window totals for everyone with activity, highest score first. */
  allTotals(now = this.now()): (ActivityTotals & { userId: string })[] {
    const w = this.weights();
    const rows = this.d.db
      .select({ userId: activityDaily.userId, ...sums })
      .from(activityDaily)
      .where(
        and(
          eq(activityDaily.guildId, this.d.guildId),
          gte(activityDaily.date, windowStartKey(now, this.windowDays())),
        ),
      )
      .groupBy(activityDaily.userId)
      .all();
    return rows
      .map((r) => {
        const counts = toCounts(r);
        return { userId: r.userId, ...counts, score: activityScore(counts, w) };
      })
      .sort((a, b) => b.score - a.score);
  }

  /** Daily counts and weighted points for a member (for charts), oldest first. */
  history(
    userId: string,
    days = 90,
    now = this.now(),
  ): (ActivityCounts & { date: string; points: ActivityPoints })[] {
    const w = this.weights();
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
      .reverse()
      .map((r) => {
        const counts: ActivityCounts = {
          messagePoints: r.messagePoints,
          voiceMinutes: r.voiceMinutes,
          images: r.imageCount,
          links: r.linkCount,
          reactions: r.reactionCount,
          reactionsReceived: r.reactionsReceivedCount,
          voiceLongMinutes: r.voiceLongMinutes,
        };
        return { date: r.date, ...counts, points: activityPoints(counts, w) };
      });
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
