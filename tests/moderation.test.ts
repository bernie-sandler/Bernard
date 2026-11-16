import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { logs, scheduledActions } from '../src/db/schema.js';
import { UserError } from '../src/services/errors.js';
import { planPurge } from '../src/services/moderation/purge.js';
import type { ModActor } from '../src/services/moderation/service.js';
import { BOT_ID, OWNER_ID, sid, testContainer } from './helpers.js';

let t: ReturnType<typeof testContainer>;
const MOD_LOG = '900000000000000010';

beforeEach(() => {
  t = testContainer();
  t.services.settings.update({ id: OWNER_ID, source: 'system' }, 'test', (s) => {
    s.logs.channels.moderation = MOD_LOG;
  });
});
afterEach(() => t.close());

/** A moderator whose highest role sits at `position`. */
function moderator(position = 10, extra: Partial<ModActor> = {}): ModActor {
  const m = t.guild.addMember({ highestRolePosition: position });
  return {
    userId: m.userId,
    displayName: m.displayName,
    isOwner: false,
    highestRolePosition: position,
    source: 'slash',
    ...extra,
  };
}
const owner = (): ModActor => {
  t.guild.addMember({ userId: OWNER_ID, isOwner: true, highestRolePosition: 99 });
  return { userId: OWNER_ID, displayName: 'Owner', isOwner: true, highestRolePosition: 99, source: 'slash' };
};
const svc = () => t.services.moderation;

describe('hierarchy and target guards', () => {
  it('refuses self, owner and the bot', async () => {
    const actor = moderator();
    await expect(svc().kick(actor, { userId: actor.userId })).rejects.toThrow("can't kick yourself");
    t.guild.addMember({ userId: OWNER_ID, isOwner: true, highestRolePosition: 99 });
    await expect(svc().kick(actor, { userId: OWNER_ID })).rejects.toThrow('server owner');
    t.guild.addMember({ userId: BOT_ID, highestRolePosition: 50 });
    await expect(svc().kick(actor, { userId: BOT_ID })).rejects.toThrow("can't kick myself");
  });

  it('refuses targets at or above the moderator', async () => {
    const actor = moderator(10);
    const peer = t.guild.addMember({ highestRolePosition: 10 });
    await expect(svc().ban(actor, { userId: peer.userId })).rejects.toThrow('equal to or above yours');
    expect(t.mod.callsTo('ban')).toHaveLength(0);
  });

  it('refuses targets at or above the bot, even for the owner', async () => {
    const boss = owner();
    const high = t.guild.addMember({ highestRolePosition: 60 });
    await expect(svc().kick(boss, { userId: high.userId })).rejects.toThrow('equal to or above mine');
  });

  it('lets the owner act on anyone below the bot', async () => {
    const boss = owner();
    const target = t.guild.addMember({ highestRolePosition: 40 });
    await expect(svc().kick(boss, { userId: target.userId })).resolves.toBeTruthy();
  });

  it('requires membership for kick/timeout/warn but not ban', async () => {
    const actor = moderator();
    const ghost = sid();
    await expect(svc().kick(actor, { userId: ghost })).rejects.toThrow('not a member');
    await expect(svc().warn(actor, { userId: ghost, reason: 'x' })).rejects.toThrow('not a member');
    await expect(svc().ban(actor, { userId: ghost })).resolves.toBeTruthy();
  });
});

describe('cases', () => {
  it('numbers cases sequentially and posts them to the moderation log', async () => {
    const actor = moderator();
    const a = t.guild.addMember();
    const b = t.guild.addMember();
    const c1 = await svc().warn(actor, { userId: a.userId, reason: 'spam' });
    const c2 = await svc().warn(actor, { userId: b.userId, reason: 'spam' });
    expect([c1.case.caseNumber, c2.case.caseNumber]).toEqual([1, 2]);
    const posted = t.messenger.sent.filter((s) => s.channelId === MOD_LOG);
    expect(posted.map((p) => p.embed.title)).toEqual(['Case #1 • Warning', 'Case #2 • Warning']);
    expect(svc().cases.get(1)?.logMessageId).toBeTruthy();
    const row = t.db.select().from(logs).where(eq(logs.type, 'moderation')).all()[0]!;
    expect(row.summary).toMatch(/Case #1 Warning <@\d+> by <@\d+> \(slash\): spam/);
  });

  it('records the source (dashboard)', async () => {
    const actor = moderator(10, { source: 'dashboard' });
    const target = t.guild.addMember();
    const { case: c } = await svc().kick(actor, { userId: target.userId, reason: 'r' });
    expect(c.source).toBe('dashboard');
    expect(t.mod.callsTo('kick')[0]!.args[1]).toMatch(/via dashboard/);
  });
});

describe('ban / unban', () => {
  it('schedules an unban for temporary bans and lifts it when due', async () => {
    const actor = moderator();
    const target = t.guild.addMember();
    const { case: c } = await svc().ban(actor, {
      userId: target.userId,
      durationMs: 3_600_000,
      deleteDays: 2,
    });
    expect(c.expiresAt).toBeInstanceOf(Date);
    expect(t.mod.callsTo('ban')[0]!.args[1]).toMatchObject({ deleteMessageSeconds: 172_800 });
    expect(t.db.select().from(scheduledActions).all()).toHaveLength(1);

    expect(await svc().processDueUnbans(new Date())).toBe(0);
    expect(await svc().processDueUnbans(new Date(Date.now() + 3_600_001))).toBe(1);
    expect(t.mod.banned.has(target.userId)).toBe(false);
    const unbanCase = svc().cases.get(2)!;
    expect(unbanCase).toMatchObject({
      action: 'unban',
      source: 'system',
      reason: 'Temporary ban expired (case #1)',
    });
    expect(t.db.select().from(scheduledActions).all()[0]!.doneAt).toBeInstanceOf(Date);
  });

  it('a manual unban cancels the pending scheduled unban', async () => {
    const actor = moderator();
    const target = t.guild.addMember();
    await svc().ban(actor, { userId: target.userId, durationMs: 3_600_000 });
    await svc().unban(actor, { userId: target.userId });
    expect(await svc().processDueUnbans(new Date(Date.now() + 7_200_000))).toBe(0);
    expect(t.mod.callsTo('unban')).toHaveLength(1);
  });

  it('retries failed unbans and gives up after 5 attempts', async () => {
    const actor = moderator();
    const target = t.guild.addMember();
    await svc().ban(actor, { userId: target.userId, durationMs: 60_000 });
    t.mod.unban = async () => {
      throw new Error('discord down');
    };
    const later = new Date(Date.now() + 120_000);
    for (let i = 0; i < 5; i++) await svc().processDueUnbans(later);
    const row = t.db.select().from(scheduledActions).all()[0]!;
    expect(row).toMatchObject({ attempts: 5, lastError: 'discord down' });
    expect(row.doneAt).toBeInstanceOf(Date);
  });

  it('rejects banning an already banned user and unbanning a non-banned one', async () => {
    const actor = moderator();
    const id = sid();
    await svc().ban(actor, { userId: id });
    await expect(svc().ban(actor, { userId: id })).rejects.toThrow('already banned');
    await expect(svc().unban(actor, { userId: sid() })).rejects.toThrow('not banned');
  });

  it('DMs members before banning, but only when enabled', async () => {
    const actor = moderator();
    const a = t.guild.addMember();
    const r1 = await svc().ban(actor, { userId: a.userId, reason: 'rude' });
    expect(r1.dmed).toBe(true);
    expect(t.mod.callsTo('dm')[0]!.args[1]).toMatch(/You were banned in \*\*Test Server\*\*.\nReason: rude/);
    t.services.settings.update({ id: OWNER_ID, source: 'system' }, 'test', (s) => {
      s.moderation.dmOnAction = false;
    });
    const b = t.guild.addMember();
    expect((await svc().ban(actor, { userId: b.userId })).dmed).toBe(false);
    expect(t.mod.callsTo('dm')).toHaveLength(1);
  });
});

describe('timeouts and warnings', () => {
  it('enforces the 28 day cap and refuses administrators', async () => {
    const actor = moderator();
    const m = t.guild.addMember();
    await expect(svc().timeout(actor, { userId: m.userId, durationMs: 29 * 86_400_000 })).rejects.toThrow(
      '28 days',
    );
    const admin = t.guild.addMember({ isAdministrator: true });
    await expect(svc().timeout(actor, { userId: admin.userId, durationMs: 60_000 })).rejects.toThrow(
      'Administrator',
    );
  });

  it('untimeout requires an active timeout', async () => {
    const actor = moderator();
    const m = t.guild.addMember();
    await expect(svc().untimeout(actor, { userId: m.userId })).rejects.toThrow('not timed out');
    await svc().timeout(actor, { userId: m.userId, durationMs: 600_000 });
    await expect(svc().untimeout(actor, { userId: m.userId })).resolves.toMatchObject({
      action: 'untimeout',
    });
  });

  it('lists and removes warnings', async () => {
    const actor = moderator();
    const m = t.guild.addMember();
    await svc().warn(actor, { userId: m.userId, reason: 'one' });
    const second = await svc().warn(actor, { userId: m.userId, reason: 'two' });
    expect(second.activeWarnings).toBe(2);
    await svc().removeWarning(actor, 1);
    expect(
      svc()
        .listWarnings(m.userId)
        .map((w) => w.reason),
    ).toEqual(['two']);
    await expect(svc().removeWarning(actor, 1)).rejects.toThrow('already removed');
    await svc().kick(actor, { userId: t.guild.addMember().userId });
    await expect(svc().removeWarning(actor, 3)).rejects.toThrow('not a warning');
  });
});

describe('roles and nicknames', () => {
  it('guards role management', async () => {
    const actor = moderator(10);
    const m = t.guild.addMember();
    const low = t.guild.addRole('Low', 5);
    const aboveActor = t.guild.addRole('Senior', 10);
    const aboveBot = t.guild.addRole('Top', 50);
    const managed = t.guild.addRole('Booster', 2, { managed: true });
    const err = (roleId: string) => svc().changeRole(actor, { userId: m.userId, roleId, add: true });
    await expect(err(aboveActor)).rejects.toThrow('above your highest role');
    await expect(err(aboveBot)).rejects.toThrow('above my highest role');
    await expect(err(managed)).rejects.toThrow('managed by an integration');
    await expect(err(t.guild.guildId)).rejects.toThrow('@everyone');
    const c = await err(low);
    expect(c).toMatchObject({ action: 'role_add', data: { roleId: low } });
    await expect(err(low)).rejects.toThrow('already have');
    await svc().changeRole(actor, { userId: m.userId, roleId: low, add: false });
    await expect(svc().changeRole(actor, { userId: m.userId, roleId: low, add: false })).rejects.toThrow(
      "don't have",
    );
  });

  it('sets and resets nicknames, allowing self', async () => {
    const actor = moderator();
    const c = await svc().setNickname(actor, { userId: actor.userId, nickname: 'Boss' });
    expect(c.data).toEqual({ before: null, after: 'Boss' });
    const reset = await svc().setNickname(actor, { userId: actor.userId });
    expect(reset.data).toEqual({ before: 'Boss', after: null });
  });
});

describe('channels', () => {
  it('locks and restores the previous overwrite on unlock', async () => {
    const actor = moderator();
    const ch = t.guild.addChannel('general');
    t.mod.lockState = { SendMessages: true };
    await svc().lock(actor, { channelId: ch });
    await expect(svc().lock(actor, { channelId: ch })).rejects.toThrow('already locked');
    await svc().unlock(actor, { channelId: ch });
    expect(t.mod.lockState).toEqual({ SendMessages: true });
    const lockCase = svc().cases.latest('lock', ch)!;
    expect(lockCase.active).toBe(false);
    await expect(svc().lock(actor, { channelId: ch })).resolves.toBeTruthy();
  });

  it('refuses unsupported channel kinds', async () => {
    const actor = moderator();
    const cat = t.guild.addChannel('Category', 'category');
    await expect(svc().slowmode(actor, { channelId: cat, seconds: 5 })).rejects.toThrow('category channel');
    await expect(svc().purge(actor, { channelId: sid(), amount: 5 })).rejects.toThrow('does not exist');
  });

  it('enforces announcement length limits', async () => {
    const actor = moderator();
    const ch = t.guild.addChannel('news', 'announcement');
    await expect(svc().announce(actor, { channelId: ch, message: 'x'.repeat(2001) })).rejects.toBeInstanceOf(
      UserError,
    );
    await expect(
      svc().announce(actor, { channelId: ch, message: 'x'.repeat(2001), asEmbed: true }),
    ).resolves.toBeTruthy();
    await svc().announce(actor, { channelId: ch, message: 'line1\\nline2', title: 'Hi' });
    expect(t.mod.callsTo('sendMessage').at(-1)!.args[1]).toEqual({ content: '**Hi**\nline1\nline2' });
  });
});

describe('purge', () => {
  const now = new Date('2026-06-01T00:00:00Z');
  const msg = (author: string, ageDays: number, pinned = false) => ({
    id: sid(),
    authorId: author,
    createdAt: new Date(now.getTime() - ageDays * 86_400_000),
    pinned,
  });

  it('planPurge keeps pinned, skips >14 day old and honours the user filter', () => {
    const scanned = [msg('a', 0), msg('b', 1), msg('a', 2, true), msg('a', 15), msg('a', 3)];
    expect(planPurge(scanned, { amount: 3, now })).toMatchObject({
      skippedPinned: 1,
      skippedOld: 0,
      scanned: 5,
    });
    const filtered = planPurge(scanned, { amount: 10, userId: 'a', now });
    expect(filtered).toMatchObject({ skippedPinned: 1, skippedOld: 1 });
    expect(filtered.toDelete).toEqual([scanned[0]!.id, scanned[4]!.id]);
  });

  it('pages through up to 500 messages when filtering by user', async () => {
    const actor = moderator();
    const ch = t.guild.addChannel('general');
    const target = t.guild.addMember();
    const others = Array.from({ length: 250 }, () => ({
      id: sid(),
      authorId: 'x',
      createdAt: new Date(),
      pinned: false,
    }));
    const theirs = Array.from({ length: 3 }, () => ({
      id: sid(),
      authorId: target.userId,
      createdAt: new Date(),
      pinned: false,
    }));
    t.mod.messages.set(ch, [...others, ...theirs]);
    const r = await svc().purge(actor, { channelId: ch, amount: 5, userId: target.userId });
    expect(r).toMatchObject({ deleted: 3, scanned: 253 });
    expect(t.mod.callsTo('fetchMessages')).toHaveLength(3);
    expect(r.case.data).toMatchObject({ targetType: 'user', channelId: ch, deleted: 3 });
  });

  it('fetches only `amount` messages without a user filter', async () => {
    const actor = moderator();
    const ch = t.guild.addChannel('general');
    t.mod.messages.set(
      ch,
      Array.from({ length: 50 }, () => ({ id: sid(), authorId: 'x', createdAt: new Date(), pinned: false })),
    );
    const r = await svc().purge(actor, { channelId: ch, amount: 10 });
    expect(r.deleted).toBe(10);
    expect(t.mod.callsTo('fetchMessages')[0]!.args[1]).toBe(10);
  });
});

describe('external actions', () => {
  it('records native Discord actions with source=discord', async () => {
    const c = await svc().recordExternal({
      action: 'ban',
      targetId: sid(),
      moderatorId: sid(),
      reason: 'via UI',
    });
    expect(c).toMatchObject({ source: 'discord', action: 'ban', reason: 'via UI' });
    expect(t.messenger.sent.at(-1)!.embed.fields).toEqual(
      expect.arrayContaining([{ name: 'Source', value: 'discord', inline: true }]),
    );
  });
});
