import { and, count, desc, eq, gte, isNotNull, isNull, lte, ne } from 'drizzle-orm';
import type { CrazyAction } from '../config/settings.js';
import type { Db } from '../db/client.js';
import { crazyPenalties, crazyPolls, crazyVotes } from '../db/schema.js';
import { describeDiscordError } from '../discord/errors.js';
import type { GuildPort, MessengerPort, ModerationPort, VoicePort } from '../discord/ports.js';
import type { Logger } from '../logger.js';
import { COLORS } from '../shared/commandResult.js';
import type { OutgoingMessage } from '../shared/messages.js';
import type { AuditActor, AuditService } from './audit.js';
import { UserError } from './errors.js';
import type { SettingsService } from './settings.js';

/** Custom ID prefix of the poll's vote button: `crazy:vote:<pollId>`. */
export const CRAZY_VOTE_PREFIX = 'crazy:vote:';

export function parseCrazyVoteId(customId: string): number | null {
  if (!customId.startsWith(CRAZY_VOTE_PREFIX)) return null;
  const id = Number(customId.slice(CRAZY_VOTE_PREFIX.length));
  return Number.isInteger(id) && id > 0 ? id : null;
}

type Poll = typeof crazyPolls.$inferSelect;
type Penalty = typeof crazyPenalties.$inferSelect;

/** Penalties Bernard undoes itself; a timeout ends on Discord's side. */
type VoiceEffect = 'mute' | 'deafen';

const ACTION_TEXT: Record<CrazyAction, string> = {
  mute: 'muted',
  deafen: 'deafened',
  disconnect: 'kept out of voice',
  timeout: 'timed out',
};

export interface CrazyStrikes {
  /** Passed polls that still count (inside the strike window, not reset). */
  strikes: number;
  history: { pollId: number; at: Date; strike: number | null; pardoned: boolean }[];
  active: { action: CrazyAction; endsAt: Date; waiting: boolean }[];
}

export interface ThatsCrazyDeps {
  db: Db;
  guildId: string;
  guild: GuildPort;
  voice: VoicePort;
  mod: ModerationPort;
  messenger: MessengerPort;
  settings: SettingsService;
  audit: AuditService;
  logger: Logger;
}

/**
 * "/thatscrazy @member": a short button poll. Passing gives the member a strike and the penalty for
 * that strike from the configured ladder (mute, deafen, disconnect, timeout), plus a DM.
 *
 * Mute, deafen and disconnect are stored with an end time and enforced while the member is in voice:
 * applied when they join if they weren't connected, undone once the time is up (on their next join if
 * they had left by then). A disconnect penalty disconnects them again on every join until it ends.
 */
export class ThatsCrazyService {
  private readonly timers = new Map<number, ReturnType<typeof setTimeout>>();
  /** Pending penalties the minute job failed to apply; it stops retrying them (joins still do). */
  private readonly failedApply = new Set<number>();

  constructor(private readonly d: ThatsCrazyDeps) {}

  private get cfg() {
    return this.d.settings.get().thatsCrazy;
  }

  /**
   * The /thatscrazy command: start a poll on `targetId`, or add a vote when one is already open.
   * Returns the reply for the caller.
   */
  async invoke(actorId: string, targetId: string, channelId: string | undefined): Promise<string> {
    const cfg = this.cfg;
    if (!cfg.enabled) throw new UserError("That's crazy is turned off on this server.");
    const open = this.openPollFor(targetId);
    if (open) {
      const result = await this.vote(open.id, actorId);
      return `${result} ${this.link(open)}`.trim();
    }
    if (!channelId) throw new UserError('Use /thatscrazy in a Discord channel.');
    await this.checkTarget(actorId, targetId);
    const now = Date.now();
    this.checkCooldowns(actorId, targetId, now);

    const needed = this.votesNeeded(targetId);
    const poll = this.d.db
      .insert(crazyPolls)
      .values({
        guildId: this.d.guildId,
        targetId,
        starterId: actorId,
        channelId,
        needed,
        expiresAt: new Date(now + cfg.pollSeconds * 1000),
        createdAt: new Date(now),
      })
      .returning()
      .get();
    this.d.db.insert(crazyVotes).values({ pollId: poll.id, voterId: actorId }).run();

    let messageId: string | null = null;
    try {
      messageId = await this.d.messenger.send(channelId, this.render(poll, 1));
    } catch (err) {
      this.d.logger.warn({ err, channelId }, "Could not post a that's crazy poll");
    }
    if (!messageId) {
      this.d.db.delete(crazyPolls).where(eq(crazyPolls.id, poll.id)).run();
      throw new UserError("I can't post in this channel. Try another one.");
    }
    this.d.db.update(crazyPolls).set({ messageId }).where(eq(crazyPolls.id, poll.id)).run();
    const saved = { ...poll, messageId };

    if (needed <= 1) {
      await this.pass(saved);
      return 'Poll started, and your vote settled it.';
    }
    this.armTimer(saved);
    return `Poll started: ${needed} votes needed, yours included.`;
  }

  /** Add a vote (the command or the poll's button). Returns the reply for the voter. */
  async vote(pollId: number, voterId: string): Promise<string> {
    const poll = this.getPoll(pollId);
    if (!poll || poll.status !== 'open') return 'This poll is already closed.';
    if (poll.expiresAt.getTime() <= Date.now()) {
      await this.fail(poll);
      return 'This poll is already closed.';
    }
    if (voterId === poll.targetId) throw new UserError("You can't vote on your own poll. Nice try.");
    const inserted = this.d.db.insert(crazyVotes).values({ pollId, voterId }).onConflictDoNothing().run();
    if (inserted.changes === 0) return 'You already voted.';
    const votes = this.voteCount(pollId);
    if (votes >= poll.needed) {
      await this.pass(poll);
      return 'Vote counted. That settles it.';
    }
    await this.editPoll(poll, this.render(poll, votes));
    return `Vote counted (${votes} / ${poll.needed}).`;
  }

  /**
   * Minute job: close polls that ran out (also those left open by a restart), lift penalties that
   * ended, and apply waiting penalties to members who are in voice now. Returns how much changed.
   */
  async tick(): Promise<number> {
    const now = Date.now();
    let changed = 0;
    const expired = this.d.db
      .select()
      .from(crazyPolls)
      .where(
        and(
          eq(crazyPolls.guildId, this.d.guildId),
          eq(crazyPolls.status, 'open'),
          lte(crazyPolls.expiresAt, new Date(now)),
        ),
      )
      .all();
    for (const poll of expired) {
      if (await this.fail(poll)) changed++;
    }

    for (const p of this.unlifted()) {
      const inVoice = this.d.voice.memberVoiceChannel(p.targetId) !== null;
      if (p.endsAt.getTime() <= now) {
        if (await this.lift(p, inVoice)) changed++;
      } else if (p.appliedAt === null && inVoice && !this.failedApply.has(p.id) && p.action !== 'timeout') {
        try {
          await this.enforce(p);
          changed++;
        } catch (err) {
          this.failedApply.add(p.id);
          this.d.logger.warn({ err, penaltyId: p.id }, "Could not apply a that's crazy penalty");
        }
      }
    }
    return changed;
  }

  /** A member joined (or moved between) voice channels: apply or undo their penalties. */
  async onVoiceJoin(userId: string): Promise<void> {
    const now = Date.now();
    for (const p of this.unlifted(userId)) {
      if (p.endsAt.getTime() <= now) {
        await this.lift(p, true);
        continue;
      }
      // Discord keeps server mute/deafen across reconnects, so those only need applying once.
      if (p.action === 'disconnect' || (p.appliedAt === null && p.action !== 'timeout')) {
        try {
          await this.enforce(p);
        } catch (err) {
          this.d.logger.warn({ err, penaltyId: p.id }, "Could not apply a that's crazy penalty");
        }
      }
    }
  }

  strikes(userId: string): CrazyStrikes {
    const since = this.strikeWindowStart();
    const passed = this.d.db
      .select()
      .from(crazyPolls)
      .where(
        and(
          eq(crazyPolls.guildId, this.d.guildId),
          eq(crazyPolls.targetId, userId),
          eq(crazyPolls.status, 'passed'),
        ),
      )
      .orderBy(desc(crazyPolls.resolvedAt))
      .limit(10)
      .all();
    const now = Date.now();
    return {
      strikes: this.countStrikes(userId, since),
      history: passed.map((p) => ({
        pollId: p.id,
        at: p.resolvedAt ?? p.createdAt,
        strike: p.strike,
        pardoned: p.pardonedAt !== null,
      })),
      active: this.unlifted(userId)
        .filter((p) => p.endsAt.getTime() > now)
        .map((p) => ({ action: p.action, endsAt: p.endsAt, waiting: p.appliedAt === null })),
    };
  }

  /** Clear a member's strikes and end their penalties. Returns how many strikes were cleared. */
  async reset(actor: AuditActor, userId: string): Promise<number> {
    const now = new Date();
    const cleared = this.d.db
      .update(crazyPolls)
      .set({ pardonedAt: now })
      .where(
        and(
          eq(crazyPolls.guildId, this.d.guildId),
          eq(crazyPolls.targetId, userId),
          eq(crazyPolls.status, 'passed'),
          isNull(crazyPolls.pardonedAt),
        ),
      )
      .run().changes;
    const inVoice = this.d.voice.memberVoiceChannel(userId) !== null;
    const active = this.unlifted(userId);
    // End them all first so lift() doesn't see the others as still running.
    this.d.db
      .update(crazyPenalties)
      .set({ endsAt: now })
      .where(
        and(
          eq(crazyPenalties.guildId, this.d.guildId),
          eq(crazyPenalties.targetId, userId),
          isNull(crazyPenalties.liftedAt),
        ),
      )
      .run();
    for (const p of active) {
      if (p.action === 'timeout' && p.appliedAt && p.endsAt > now) {
        await this.d.mod.timeout(userId, null, "That's crazy strikes reset").catch((err) => {
          this.d.logger.warn({ err, userId }, 'Could not clear a timeout');
        });
      }
      await this.lift({ ...p, endsAt: now }, inVoice);
    }
    this.d.audit.record(actor, { action: 'thatsCrazy.reset', target: userId, before: { strikes: cleared } });
    return cleared;
  }

  /** Stop poll timers (shutdown and tests). */
  stop(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  // ── Starting a poll ───────────────────────────────────────────────────────

  private async checkTarget(actorId: string, targetId: string): Promise<void> {
    if (actorId === targetId)
      throw new UserError("You can't call yourself crazy. Others will do it for you.");
    const member = await this.d.guild.getMember(targetId);
    if (!member) throw new UserError("That person isn't on this server.");
    if (member.isBot) throw new UserError('Bots are never crazy. Just misunderstood.');
    if (member.isOwner) throw new UserError("The server owner can't be voted on.");
    const exempt = new Set(this.cfg.exemptRoleIds);
    if (member.roleIds.some((r) => exempt.has(r))) {
      throw new UserError(`${member.displayName} is exempt from that's crazy votes.`);
    }
  }

  private checkCooldowns(actorId: string, targetId: string, now: number): void {
    const cfg = this.cfg;
    const last = this.d.db
      .select()
      .from(crazyPolls)
      .where(
        and(
          eq(crazyPolls.guildId, this.d.guildId),
          eq(crazyPolls.targetId, targetId),
          isNotNull(crazyPolls.resolvedAt),
        ),
      )
      .orderBy(desc(crazyPolls.resolvedAt))
      .limit(1)
      .get();
    if (last?.resolvedAt) {
      const minutes = last.status === 'passed' ? cfg.targetCooldownMinutes : cfg.failedCooldownMinutes;
      const until = last.resolvedAt.getTime() + minutes * 60_000;
      if (until > now) {
        throw new UserError(`Give them a break. Try again <t:${Math.ceil(until / 1000)}:R>.`);
      }
    }
    const started = this.d.db
      .select()
      .from(crazyPolls)
      .where(and(eq(crazyPolls.guildId, this.d.guildId), eq(crazyPolls.starterId, actorId)))
      .orderBy(desc(crazyPolls.createdAt))
      .limit(1)
      .get();
    if (started) {
      const until = started.createdAt.getTime() + cfg.starterCooldownMinutes * 60_000;
      if (until > now) {
        throw new UserError(`You started one recently. Try again <t:${Math.ceil(until / 1000)}:R>.`);
      }
    }
  }

  /** max(minVotes, voiceShare × the other people in the target's voice channel), rounded up. */
  private votesNeeded(targetId: string): number {
    const { minVotes, voiceShare } = this.cfg;
    const channelId = this.d.voice.memberVoiceChannel(targetId);
    if (!channelId) return minVotes;
    const others = this.d.voice.channelMembers(channelId).filter((u) => u !== targetId).length;
    return Math.max(minVotes, Math.ceil(voiceShare * others));
  }

  // ── Resolving ─────────────────────────────────────────────────────────────

  private async pass(poll: Poll): Promise<void> {
    const now = new Date();
    // Claim the poll first so a vote racing in can't resolve it twice.
    const claimed = this.d.db
      .update(crazyPolls)
      .set({ status: 'passed', resolvedAt: now })
      .where(and(eq(crazyPolls.id, poll.id), eq(crazyPolls.status, 'open')))
      .run();
    if (claimed.changes === 0) return;
    this.clearTimer(poll.id);
    const cfg = this.cfg;
    const strike = this.countStrikes(poll.targetId, this.strikeWindowStart());
    this.d.db.update(crazyPolls).set({ strike }).where(eq(crazyPolls.id, poll.id)).run();
    const step = cfg.ladder[Math.min(strike, cfg.ladder.length) - 1] ?? { action: 'mute', minutes: 1 };

    const penalty = this.d.db
      .insert(crazyPenalties)
      .values({
        guildId: this.d.guildId,
        pollId: poll.id,
        targetId: poll.targetId,
        action: step.action,
        endsAt: new Date(now.getTime() + step.minutes * 60_000),
      })
      .returning()
      .get();

    let outcome: 'applied' | 'waiting' | 'failed' = 'waiting';
    let error: string | null = null;
    const inVoice = this.d.voice.memberVoiceChannel(poll.targetId) !== null;
    if (step.action === 'timeout' || inVoice) {
      try {
        await this.enforce(penalty);
        outcome = 'applied';
      } catch (err) {
        outcome = 'failed';
        error = describeDiscordError(err) ?? 'Discord refused.';
        this.d.logger.warn({ err, pollId: poll.id }, "Could not apply a that's crazy penalty");
      }
    }

    const text = this.dmText(strike, step.action, step.minutes);
    if (text) await this.d.mod.dm(poll.targetId, text).catch(() => false);

    const votes = this.voteCount(poll.id);
    const what = `**${ACTION_TEXT[step.action]} for ${step.minutes} min**`;
    const lines = [`The people have spoken: <@${poll.targetId}> is ${what} (strike ${strike}).`];
    if (outcome === 'waiting') lines.push('It starts when they join voice.');
    if (outcome === 'failed') lines.push(`I couldn't apply it: ${error}`);
    await this.editPoll(poll, {
      embed: {
        title: "🤯 That's crazy!",
        description: lines.join('\n'),
        color: COLORS.danger,
        fields: [{ name: 'Votes', value: `${votes} / ${poll.needed}`, inline: true }],
      },
      buttons: [],
    });
  }

  /** Close an open poll as failed. Returns false when it was already closed. */
  private async fail(poll: Poll): Promise<boolean> {
    const claimed = this.d.db
      .update(crazyPolls)
      .set({ status: 'failed', resolvedAt: new Date() })
      .where(and(eq(crazyPolls.id, poll.id), eq(crazyPolls.status, 'open')))
      .run();
    if (claimed.changes === 0) return false;
    this.clearTimer(poll.id);
    const votes = this.voteCount(poll.id);
    await this.editPoll(poll, {
      embed: {
        title: 'Not crazy enough',
        description: `<@${poll.targetId}> walks free this time.`,
        color: COLORS.neutral,
        fields: [{ name: 'Votes', value: `${votes} / ${poll.needed}`, inline: true }],
      },
      buttons: [],
    });
    return true;
  }

  // ── Penalties ─────────────────────────────────────────────────────────────

  /** Put a penalty into effect now. Throws the Discord error when it can't. */
  private async enforce(p: Penalty): Promise<void> {
    const reason = "That's crazy vote";
    switch (p.action) {
      case 'timeout':
        await this.d.mod.timeout(p.targetId, Math.max(1000, p.endsAt.getTime() - Date.now()), reason);
        break;
      case 'mute':
        await this.d.voice.setServerVoice(p.targetId, { mute: true }, reason);
        break;
      case 'deafen':
        await this.d.voice.setServerVoice(p.targetId, { deaf: true }, reason);
        break;
      case 'disconnect':
        await this.d.voice.moveMember(p.targetId, null);
        break;
    }
    this.failedApply.delete(p.id);
    if (p.appliedAt === null) {
      const appliedAt = new Date();
      this.d.db.update(crazyPenalties).set({ appliedAt }).where(eq(crazyPenalties.id, p.id)).run();
      p.appliedAt = appliedAt;
    }
  }

  /**
   * Finish an ended penalty. A mute or deafen that took effect is undone, unless another one of the
   * same kind is still running; when the member isn't in voice that waits for their next join.
   * Returns true when the penalty was marked lifted.
   */
  private async lift(p: Penalty, inVoice: boolean): Promise<boolean> {
    if ((p.action === 'mute' || p.action === 'deafen') && p.appliedAt !== null) {
      if (!this.stillRunning(p.targetId, p.action, p.id)) {
        if (!inVoice) return false;
        const state = p.action === 'mute' ? { mute: false } : { deaf: false };
        try {
          await this.d.voice.setServerVoice(p.targetId, state, "That's crazy penalty ended");
        } catch (err) {
          this.d.logger.warn({ err, penaltyId: p.id }, "Could not lift a that's crazy penalty");
          return false;
        }
      }
    }
    this.d.db.update(crazyPenalties).set({ liftedAt: new Date() }).where(eq(crazyPenalties.id, p.id)).run();
    this.failedApply.delete(p.id);
    return true;
  }

  /** Another penalty of this kind on the member is still in its time. */
  private stillRunning(userId: string, action: VoiceEffect, exceptId: number): boolean {
    const row = this.d.db
      .select({ id: crazyPenalties.id })
      .from(crazyPenalties)
      .where(
        and(
          eq(crazyPenalties.guildId, this.d.guildId),
          eq(crazyPenalties.targetId, userId),
          eq(crazyPenalties.action, action),
          isNull(crazyPenalties.liftedAt),
          ne(crazyPenalties.id, exceptId),
          gte(crazyPenalties.endsAt, new Date(Date.now() + 1)),
        ),
      )
      .get();
    return row !== undefined;
  }

  private unlifted(userId?: string): Penalty[] {
    return this.d.db
      .select()
      .from(crazyPenalties)
      .where(
        and(
          eq(crazyPenalties.guildId, this.d.guildId),
          isNull(crazyPenalties.liftedAt),
          userId ? eq(crazyPenalties.targetId, userId) : undefined,
        ),
      )
      .orderBy(crazyPenalties.endsAt)
      .all();
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private dmText(strike: number, action: CrazyAction, minutes: number): string | null {
    const templates = this.cfg.dmMessages;
    const template = templates[Math.min(strike, templates.length) - 1];
    if (!template) return null;
    const vars: Record<string, string> = {
      count: String(strike),
      action: ACTION_TEXT[action],
      minutes: String(minutes),
      server: this.d.guild.summary().name,
    };
    return template.replace(/\{(count|action|minutes|server)\}/g, (_, k: string) => vars[k] ?? '');
  }

  private strikeWindowStart(): Date {
    return new Date(Date.now() - this.cfg.strikeWindowDays * 86_400_000);
  }

  private countStrikes(userId: string, since: Date): number {
    const row = this.d.db
      .select({ n: count() })
      .from(crazyPolls)
      .where(
        and(
          eq(crazyPolls.guildId, this.d.guildId),
          eq(crazyPolls.targetId, userId),
          eq(crazyPolls.status, 'passed'),
          isNull(crazyPolls.pardonedAt),
          gte(crazyPolls.resolvedAt, since),
        ),
      )
      .get();
    return row?.n ?? 0;
  }

  private openPollFor(targetId: string): Poll | undefined {
    return this.d.db
      .select()
      .from(crazyPolls)
      .where(
        and(
          eq(crazyPolls.guildId, this.d.guildId),
          eq(crazyPolls.targetId, targetId),
          eq(crazyPolls.status, 'open'),
          gte(crazyPolls.expiresAt, new Date(Date.now() + 1)),
          isNotNull(crazyPolls.messageId),
        ),
      )
      .get();
  }

  private getPoll(id: number): Poll | undefined {
    return this.d.db
      .select()
      .from(crazyPolls)
      .where(and(eq(crazyPolls.id, id), eq(crazyPolls.guildId, this.d.guildId)))
      .get();
  }

  private voteCount(pollId: number): number {
    return (
      this.d.db.select({ n: count() }).from(crazyVotes).where(eq(crazyVotes.pollId, pollId)).get()?.n ?? 0
    );
  }

  private link(poll: Poll): string {
    return poll.messageId
      ? `https://discord.com/channels/${this.d.guildId}/${poll.channelId}/${poll.messageId}`
      : '';
  }

  private render(poll: Poll, votes: number): OutgoingMessage {
    const closes = Math.ceil(poll.expiresAt.getTime() / 1000);
    return {
      embed: {
        title: "🤯 That's crazy?",
        description: `<@${poll.starterId}> thinks <@${poll.targetId}> said something crazy. Agree? Vote below.\nCloses <t:${closes}:R>.`,
        color: COLORS.warning,
        fields: [{ name: 'Votes', value: `${votes} / ${poll.needed}`, inline: true }],
      },
      buttons: [
        { customId: `${CRAZY_VOTE_PREFIX}${poll.id}`, label: "That's crazy", emoji: '🤯', style: 'danger' },
      ],
    };
  }

  private async editPoll(poll: Poll, msg: OutgoingMessage): Promise<void> {
    if (!poll.messageId) return;
    try {
      await this.d.messenger.edit(poll.channelId, poll.messageId, msg);
    } catch (err) {
      this.d.logger.warn({ err, pollId: poll.id }, "Could not update a that's crazy poll");
    }
  }

  private armTimer(poll: Poll): void {
    const t = setTimeout(
      () => {
        this.timers.delete(poll.id);
        const fresh = this.getPoll(poll.id);
        if (fresh?.status === 'open') {
          this.fail(fresh).catch((err) =>
            this.d.logger.error({ err, pollId: poll.id }, "Closing a that's crazy poll failed"),
          );
        }
      },
      Math.max(0, poll.expiresAt.getTime() - Date.now()),
    );
    t.unref?.();
    this.timers.set(poll.id, t);
  }

  private clearTimer(pollId: number): void {
    const t = this.timers.get(pollId);
    if (t) clearTimeout(t);
    this.timers.delete(pollId);
  }
}
