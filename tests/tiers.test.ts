import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { activityDaily, logs, memberTierState } from '../src/db/schema.js';
import { dateKey, eligibleVoiceUsers } from '../src/services/activity.js';
import { DAY_MS, tenureDays } from '../src/services/members.js';
import { type PlanInput, planTiers, type TierDef } from '../src/services/tiers.js';
import { GUILD_ID, makeActor, OWNER_ID, sid, testContainer } from './helpers.js';

const NOW = new Date('2026-06-01T12:00:00Z');
const ADMIN = { id: OWNER_ID, source: 'slash' as const };

// ── Pure logic ──────────────────────────────────────────────────────────────

describe('planTiers', () => {
  const T: TierDef[] = [
    { id: 1, name: 'Bronze', roleId: 'r1', minTenureDays: 0, minActivity: 10, position: 1 },
    { id: 2, name: 'Silver', roleId: 'r2', minTenureDays: 30, minActivity: 50, position: 2 },
    { id: 3, name: 'Veteran', roleId: 'r3', minTenureDays: 365, minActivity: 0, position: 3 },
  ];
  const plan = (p: Partial<PlanInput>) =>
    planTiers({
      tiers: T,
      roleIds: [],
      tenureDays: 0,
      score: 0,
      belowSince: new Map(),
      mode: 'highest_only',
      demotion: true,
      graceDays: 7,
      now: NOW,
      ...p,
    });

  it('requires both thresholds; 0 makes a tier tenure-only or activity-only', () => {
    expect(plan({ score: 10 }).add).toEqual(['r1']);
    expect(plan({ tenureDays: 40, score: 49 }).add).toEqual(['r1']);
    expect(plan({ tenureDays: 400, score: 0 }).add).toEqual(['r3']); // tenure-only
    expect(plan({ tenureDays: 5, score: 0 }).add).toEqual([]);
  });

  it('highest_only keeps just the top earned tier and removes lower ones', () => {
    const r = plan({ tenureDays: 40, score: 60, roleIds: ['r1'] });
    expect(r).toMatchObject({ add: ['r2'], remove: ['r1'] });
  });

  it('stack keeps every earned tier', () => {
    const r = plan({ mode: 'stack', tenureDays: 400, score: 60 });
    expect(r.add).toEqual(['r1', 'r2', 'r3']);
    expect(r.remove).toEqual([]);
  });

  it('with demotion off, held tiers are kept even when no longer earned', () => {
    const r = plan({ demotion: false, score: 0, roleIds: ['r1'] });
    expect(r).toMatchObject({ add: [], remove: [] });
  });

  it('with demotion on, a held tier survives the grace period and is then removed', () => {
    const first = plan({ score: 0, roleIds: ['r1'] });
    expect(first.remove).toEqual([]);
    expect(first.belowSince.get(1)).toEqual(NOW);

    const during = plan({
      score: 0,
      roleIds: ['r1'],
      belowSince: first.belowSince,
      now: new Date(NOW.getTime() + 6 * DAY_MS),
    });
    expect(during.remove).toEqual([]);

    const after = plan({
      score: 0,
      roleIds: ['r1'],
      belowSince: first.belowSince,
      now: new Date(NOW.getTime() + 7 * DAY_MS),
    });
    expect(after.remove).toEqual(['r1']);
    expect(after.belowSince.size).toBe(0);
  });

  it('requalifying clears the grace timer', () => {
    const below = new Map([[1, new Date(NOW.getTime() - 3 * DAY_MS)]]);
    expect(plan({ score: 20, roleIds: ['r1'], belowSince: below }).belowSince.size).toBe(0);
  });

  it('demoting from a higher tier hands down the tier still earned', () => {
    const below = new Map([[2, new Date(NOW.getTime() - 8 * DAY_MS)]]);
    const r = plan({ tenureDays: 40, score: 20, roleIds: ['r2'], belowSince: below });
    expect(r).toMatchObject({ add: ['r1'], remove: ['r2'] });
  });

  it('a retained higher tier still outranks a lower earned one during grace', () => {
    const r = plan({ tenureDays: 40, score: 20, roleIds: ['r2'] });
    expect(r).toMatchObject({ add: [], remove: [] });
  });
});

describe('eligibleVoiceUsers', () => {
  const ch = (channelId: string, members: [string, boolean?, boolean?][]) => ({
    channelId,
    members: members.map(([userId, isBot = false, selfDeaf = false]) => ({ userId, isBot, selfDeaf })),
  });

  it('excludes AFK, people alone (bots are not company) and self-deafened members', () => {
    const snap = [
      ch('afk', [['a'], ['b']]),
      ch('solo', [['c'], ['bot', true]]),
      ch('pair', [['d'], ['e', false, true]]),
      ch('trio', [['f'], ['g'], ['h']]),
    ];
    expect(eligibleVoiceUsers(snap, { afkChannelId: 'afk', countSelfDeafened: false }).sort()).toEqual([
      'd',
      'f',
      'g',
      'h',
    ]);
    expect(eligibleVoiceUsers(snap, { afkChannelId: 'afk', countSelfDeafened: true }).sort()).toEqual([
      'd',
      'e',
      'f',
      'g',
      'h',
    ]);
  });
});

// ── Services ────────────────────────────────────────────────────────────────

let t: ReturnType<typeof testContainer>;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  t = testContainer();
});
afterEach(() => {
  t.services.tiers.stop();
  t.close();
  vi.useRealTimers();
});

describe('ActivityService', () => {
  const none = { messagePoints: 0, voiceMinutes: 0, images: 0, links: 0, reactions: 0 };

  it('awards one point per message with a per-user cooldown', () => {
    const a = t.services.activity;
    expect(a.recordMessage('u1')).toEqual(['message']);
    expect(a.recordMessage('u1')).toEqual([]);
    expect(a.recordMessage('u2')).toEqual(['message']);
    vi.advanceTimersByTime(60_000);
    expect(a.recordMessage('u1')).toEqual(['message']);
    expect(a.totals('u1')).toEqual({ ...none, messagePoints: 2, score: 2 });
  });

  it('adds image and link bonuses on top of the message point, each with its own cooldown', () => {
    const a = t.services.activity;
    expect(a.recordMessage('u1', { image: true, link: true })).toEqual(['message', 'image', 'link']);
    // Message and link are cooling down; an image alone still can't earn either.
    expect(a.recordMessage('u1', { image: true, link: true })).toEqual([]);
    vi.advanceTimersByTime(30_000);
    expect(a.recordMessage('u1', { image: true })).toEqual([]);
    vi.advanceTimersByTime(30_000);
    expect(a.recordMessage('u1', { link: true })).toEqual(['message', 'link']);
    expect(a.recordMessage('u1', { image: true })).toEqual(['image']);
    // Defaults: 1/message, +1/image, +0.5/link.
    expect(a.totals('u1')).toEqual({ ...none, messagePoints: 2, images: 2, links: 2, score: 5 });
  });

  it('awards reactions with their own cooldown', () => {
    const a = t.services.activity;
    a.recordMessage('u1');
    expect(a.recordReaction('u1')).toBe(true);
    expect(a.recordReaction('u1')).toBe(false);
    vi.advanceTimersByTime(60_000);
    expect(a.recordReaction('u1')).toBe(true);
    expect(a.totals('u1')).toEqual({ ...none, messagePoints: 1, reactions: 2, score: 1.5 });
  });

  it('weights voice minutes at 0.2 points by default', () => {
    t.db
      .insert(activityDaily)
      .values({ guildId: GUILD_ID, userId: 'u1', date: dateKey(NOW.getTime()), voiceMinutes: 60 })
      .run();
    expect(t.services.activity.totals('u1').score).toBe(12);
  });

  it('applies weights at read time and only counts the rolling window', () => {
    const a = t.services.activity;
    t.db
      .insert(activityDaily)
      .values([
        {
          guildId: GUILD_ID,
          userId: 'u1',
          date: dateKey(NOW.getTime()),
          messagePoints: 3,
          voiceMinutes: 10,
          imageCount: 2,
          linkCount: 2,
          reactionCount: 4,
        },
        {
          guildId: GUILD_ID,
          userId: 'u1',
          date: dateKey(NOW.getTime() - 29 * DAY_MS),
          messagePoints: 1,
          voiceMinutes: 0,
        },
        {
          guildId: GUILD_ID,
          userId: 'u1',
          date: dateKey(NOW.getTime() - 30 * DAY_MS),
          messagePoints: 100,
          voiceMinutes: 0,
        },
      ])
      .run();
    // 4×1 + 10×0.2 + 2×1 + 2×0.5 + 4×0.25
    expect(a.totals('u1')).toEqual({
      messagePoints: 4,
      voiceMinutes: 10,
      images: 2,
      links: 2,
      reactions: 4,
      score: 10,
    });
    t.services.settings.update(ADMIN, 'test', (s) => {
      s.activity.pointsPerMessage = 2;
      s.activity.pointsPerVoiceMinute = 0.5;
      s.activity.pointsPerImage = 0;
      s.activity.pointsPerLink = 1;
      s.activity.pointsPerReaction = 1;
    });
    // 4×2 + 10×0.5 + 0 + 2×1 + 4×1
    expect(a.totals('u1').score).toBe(19);
    expect(a.allTotals()[0]).toMatchObject({ userId: 'u1', score: 19 });
    expect(a.history('u1', 1)).toEqual([
      expect.objectContaining({
        date: dateKey(NOW.getTime()),
        images: 2,
        points: { messages: 6, voice: 5, images: 0, links: 2, reactions: 4 },
      }),
    ]);
  });

  it('voice ticks add minutes for eligible members only', () => {
    const snap = [
      {
        channelId: 'c',
        members: [
          { userId: 'a', isBot: false, selfDeaf: false },
          { userId: 'b', isBot: false, selfDeaf: true },
        ],
      },
    ];
    expect(t.services.activity.voiceTick(snap, null)).toEqual(['a']);
    t.services.activity.voiceTick(snap, null);
    expect(t.services.activity.totals('a').voiceMinutes).toBe(2);
    expect(t.services.activity.totals('b').voiceMinutes).toBe(0);
  });

  it('queues a tier evaluation when a score crosses a tier threshold', () => {
    const role = t.guild.addRole('Active', 5);
    t.services.tiers.add(ADMIN, { name: 'Active', roleId: role, minTenureDays: 0, minActivity: 2 });
    const spy = vi.spyOn(t.services.tiers, 'queueEvaluate');
    t.services.activity.recordMessage('u1');
    expect(spy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(61_000);
    t.services.activity.recordMessage('u1');
    expect(spy).toHaveBeenCalledWith('u1');
  });

  it('queues a tier evaluation when a reaction crosses a threshold', () => {
    const role = t.guild.addRole('Active', 5);
    t.services.tiers.add(ADMIN, { name: 'Active', roleId: role, minTenureDays: 0, minActivity: 1.25 });
    const spy = vi.spyOn(t.services.tiers, 'queueEvaluate');
    t.services.activity.recordMessage('u1');
    expect(spy).not.toHaveBeenCalled();
    t.services.activity.recordReaction('u1');
    expect(spy).toHaveBeenCalledWith('u1');
  });

  it('prunes history older than the retention period', () => {
    t.db
      .insert(activityDaily)
      .values({ guildId: GUILD_ID, userId: 'u', date: '2020-01-01', messagePoints: 1, voiceMinutes: 0 })
      .run();
    expect(t.services.activity.prune()).toBe(1);
  });
});

describe('MemberService', () => {
  const profile = (userId: string) => ({
    userId,
    username: 'u',
    displayName: 'U',
    avatarUrl: null,
    isBot: false,
  });

  it('backfills from Discord join dates and detects people who left while offline', () => {
    const a = t.guild.addMember({ joinedAt: new Date(NOW.getTime() - 100 * DAY_MS) });
    const gone = sid();
    t.services.members.recordJoin(profile(gone), new Date(NOW.getTime() - 5 * DAY_MS));
    const r = t.services.members.syncAll([a]);
    expect(r).toEqual({ added: 1, rejoined: 0, left: 1 });
    expect(t.services.members.tenureDaysFor(a.userId)).toBe(100);
    expect(t.services.members.get(gone)!.leftAt).toBeInstanceOf(Date);
  });

  it('keeps the first join and resets tenure on rejoin by default', () => {
    const id = sid();
    const first = new Date(NOW.getTime() - 200 * DAY_MS);
    t.services.members.recordJoin(profile(id), first);
    t.services.members.recordLeave(id);
    expect(t.services.members.recordJoin(profile(id), NOW)).toBe('rejoin');
    const row = t.services.members.get(id)!;
    expect(row.firstJoinedAt).toEqual(first);
    expect(row.joinedAt).toEqual(NOW);
    expect(row.leftAt).toBeNull();
  });

  it('can keep tenure across rejoins', () => {
    t.services.settings.update(ADMIN, 'test', (s) => {
      s.tenure.resetOnRejoin = false;
    });
    const id = sid();
    const first = new Date(NOW.getTime() - 200 * DAY_MS);
    t.services.members.recordJoin(profile(id), first);
    t.services.members.recordLeave(id);
    t.services.members.recordJoin(profile(id), NOW);
    expect(t.services.members.get(id)!.joinedAt).toEqual(first);
  });

  it('treats a newer Discord join date as a rejoin the bot missed', () => {
    const id = sid();
    t.services.members.recordJoin(profile(id), new Date(NOW.getTime() - 50 * DAY_MS));
    expect(t.services.members.recordJoin(profile(id), new Date(NOW.getTime() - DAY_MS))).toBe('rejoin');
    expect(t.services.members.recordJoin(profile(id), new Date(NOW.getTime() - DAY_MS))).toBe('existing');
  });

  it('computes tenure in whole days', () => {
    expect(tenureDays(new Date(NOW.getTime() - 1.9 * DAY_MS), NOW.getTime())).toBe(1);
  });
});

describe('TierService', () => {
  const tiers = () => t.services.tiers;
  const addTier = (name: string, minTenureDays: number, minActivity: number, position = 5) => {
    const role = t.guild.addRole(name, position);
    return tiers().add(ADMIN, { name, roleId: role, minTenureDays, minActivity });
  };

  it('enforces at most 10 tiers and validates input', () => {
    for (let i = 0; i < 10; i++) addTier(`T${i}`, i, 0);
    expect(() => addTier('T10', 10, 0)).toThrow('at most 10');
    expect(() => tiers().edit(ADMIN, tiers().list()[0]!.id, { name: 'T1' })).toThrow('already exists');
  });

  it('rejects @everyone, managed roles and duplicate roles', () => {
    const a = addTier('A', 0, 1);
    expect(() =>
      tiers().add(ADMIN, { name: 'B', roleId: GUILD_ID, minTenureDays: 0, minActivity: 0 }),
    ).toThrow('@everyone');
    const managed = t.guild.addRole('Bot', 2, { managed: true });
    expect(() =>
      tiers().add(ADMIN, { name: 'B', roleId: managed, minTenureDays: 0, minActivity: 0 }),
    ).toThrow('managed');
    expect(() =>
      tiers().add(ADMIN, { name: 'B', roleId: a.roleId, minTenureDays: 0, minActivity: 0 }),
    ).toThrow('already used');
  });

  it('inserts at a position, reorders and renumbers after removal', () => {
    const a = addTier('A', 0, 1);
    const b = addTier('B', 0, 2);
    const role = t.guild.addRole('Mid', 5);
    const mid = tiers().add(ADMIN, {
      name: 'Mid',
      roleId: role,
      minTenureDays: 0,
      minActivity: 1.5,
      position: 2,
    });
    expect(
      tiers()
        .list()
        .map((x) => x.name),
    ).toEqual(['A', 'Mid', 'B']);
    tiers().reorder(ADMIN, [b.id, a.id, mid.id]);
    expect(
      tiers()
        .list()
        .map((x) => x.name),
    ).toEqual(['B', 'A', 'Mid']);
    expect(() => tiers().reorder(ADMIN, [a.id, b.id])).toThrow('every tier exactly once');
    tiers().remove(ADMIN, a.id);
    expect(
      tiers()
        .list()
        .map((x) => [x.name, x.position]),
    ).toEqual([
      ['B', 1],
      ['Mid', 2],
    ]);
    expect(t.services.audit.list().map((r) => r.action)).toEqual(
      expect.arrayContaining(['tiers.add', 'tiers.reorder', 'tiers.remove']),
    );
  });

  it('flags roles the bot cannot manage and tiers out of order', () => {
    addTier('Easy', 10, 10);
    const role = t.guild.addRole('High', 60);
    tiers().add(ADMIN, { name: 'High', roleId: role, minTenureDays: 5, minActivity: 5 });
    const c = tiers().check();
    expect(c.ok).toBe(false);
    expect(c.issues.join('\n')).toMatch(/High\*\*: role is at or above the bot's highest role/);
    expect(c.issues.join('\n')).toMatch(/no harder to reach than \*\*Easy\*\*/);
    expect(c.tiers.find((r) => r.tier.name === 'High')!.manageable).toBe(false);
  });

  it('evaluates members, applies roles and logs to the members log', async () => {
    const MEMBERS = '900000000000000099';
    t.services.settings.update(ADMIN, 'test', (s) => {
      s.logs.channels.members = MEMBERS;
    });
    const bronze = addTier('Bronze', 0, 0);
    const silver = addTier('Silver', 30, 0);
    const m = t.guild.addMember({ joinedAt: new Date(NOW.getTime() - 40 * DAY_MS), roleIds: [] });
    const r = await tiers().evaluateMember(m);
    expect(r).toEqual({ added: [silver.roleId], removed: [], skipped: 0 });
    expect(m.roleIds).toContain(silver.roleId);
    expect(m.roleIds).not.toContain(bronze.roleId);
    expect(t.messenger.sent.at(-1)).toMatchObject({ channelId: MEMBERS, embed: { title: 'Tier updated' } });
  });

  it('skips bots, excluded roles and roles above the bot', async () => {
    const staff = t.guild.addRole('Staff', 3);
    t.services.settings.update(ADMIN, 'test', (s) => {
      s.tiers.excludedRoleIds = [staff];
    });
    addTier('Everyone', 0, 0);
    const role = t.guild.addRole('High', 60);
    tiers().add(ADMIN, { name: 'High', roleId: role, minTenureDays: 1, minActivity: 0 });
    const bot = t.guild.addMember({ isBot: true });
    const excluded = t.guild.addMember({ roleIds: [staff] });
    const normal = t.guild.addMember({ joinedAt: new Date(NOW.getTime() - 10 * DAY_MS) });
    expect((await tiers().evaluateMember(bot)).added).toEqual([]);
    expect((await tiers().evaluateMember(excluded)).added).toEqual([]);
    const r = await tiers().evaluateMember(normal);
    expect(r).toMatchObject({ added: [], skipped: 1 });
  });

  it('demotes after the grace period across evaluations', async () => {
    const active = addTier('Active', 0, 5);
    const m = t.guild.addMember({ roleIds: [active.roleId] });
    await tiers().evaluateMember(m);
    expect(m.roleIds).toContain(active.roleId);
    vi.setSystemTime(new Date(NOW.getTime() + 8 * DAY_MS));
    await tiers().evaluateMember(m);
    expect(m.roleIds).not.toContain(active.roleId);
  });

  it('syncs everyone, records the last sync and respects the interval', async () => {
    addTier('Member', 0, 0);
    t.guild.addMember();
    t.guild.addMember();
    const s = await tiers().syncAll('manual');
    expect(s).toMatchObject({ members: 2, changed: 2, errors: 0 });
    expect(tiers().lastSync()).toMatchObject({ reason: 'manual', changed: 2 });
    expect(await tiers().maybeScheduledSync()).toBeNull();
    vi.advanceTimersByTime(60 * 60_000);
    expect(await tiers().maybeScheduledSync()).toMatchObject({ reason: 'scheduled', changed: 0 });
  });

  it('flushes queued evaluations after the debounce', async () => {
    addTier('Member', 0, 0);
    const m = t.guild.addMember();
    tiers().queueEvaluate(m.userId);
    tiers().queueEvaluate(m.userId);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(t.mod.callsTo('addRole')).toHaveLength(1);
  });

  it('reports progress towards the next tier', () => {
    addTier('Bronze', 0, 0);
    addTier('Silver', 30, 100);
    const m = t.guild.addMember({ joinedAt: new Date(NOW.getTime() - 10 * DAY_MS) });
    t.services.activity.recordMessage(m.userId);
    const p = tiers().progress(m);
    expect(p.next).toMatchObject({ tier: { name: 'Silver' }, daysNeeded: 20, pointsNeeded: 99 });
  });
});

describe('commands', () => {
  const run = async (
    name: string,
    rawInput: Record<string, unknown>,
    member = t.guild.addMember({ userId: OWNER_ID }),
  ) =>
    t.executor.run({
      command: t.services.registry.find(name)!,
      actor: makeActor(member),
      source: 'slash',
      rawInput,
    });

  it('/tiers add, edit by name and remove', async () => {
    const role = t.guild.addRole('Regular', 4);
    const add = await run('tiers add', { name: 'Regular', role, min_tenure_days: 7, min_activity: 20 });
    expect(add.result.content).toMatch(/Added \*\*1\. Regular\*\*/);
    const edit = await run('tiers edit', { tier: 'regular', min_activity: 30 });
    expect(edit.result.content).toMatch(/≥ 30 activity/);
    expect((await run('tiers remove', { tier: 'nope' })).result.ok).toBe(false);
    expect((await run('tiers remove', { tier: 'Regular' })).result.ok).toBe(true);
  });

  it('/tiers exclude toggles a role', async () => {
    const staff = t.guild.addRole('Staff', 4);
    await run('tiers exclude', { role: staff });
    expect(t.services.settings.get().tiers.excludedRoleIds).toEqual([staff]);
    await run('tiers exclude', { role: staff });
    expect(t.services.settings.get().tiers.excludedRoleIds).toEqual([]);
  });

  it('/rank is public and shows tenure, activity, rank and next tier', async () => {
    const role = t.guild.addRole('Regular', 4);
    t.services.tiers.add(ADMIN, { name: 'Regular', roleId: role, minTenureDays: 30, minActivity: 0 });
    const m = t.guild.addMember({ joinedAt: new Date(NOW.getTime() - 12 * DAY_MS) });
    t.services.activity.recordMessage(m.userId);
    const res = await run('rank', {}, m);
    expect(res.outcome).toBe('ok');
    const text = JSON.stringify(res.result.embeds);
    expect(text).toContain('12 day(s)');
    expect(text).toContain('#1 of 1');
    expect(text).toContain('18 more day(s)');
  });

  it('/activity settings shows and updates values', async () => {
    const show = await run('activity settings', {});
    expect(show.result.content).toMatch(/Cooldown 60s/);
    await run('activity settings', { window_days: 14, count_deafened: true });
    expect(t.services.settings.get().activity).toMatchObject({ windowDays: 14, countSelfDeafened: true });
  });

  it('records tier changes in the members log entries', async () => {
    const role = t.guild.addRole('Member', 4);
    t.services.tiers.add(ADMIN, { name: 'Member', roleId: role, minTenureDays: 0, minActivity: 0 });
    await t.services.tiers.evaluateMember(t.guild.addMember());
    const types = t.db
      .select()
      .from(logs)
      .all()
      .map((l) => `${l.type}:${l.event}`);
    expect(types).toContain('members:tier_change');
  });
});

describe('tenure-only sync', () => {
  /** Mirrors a fresh install: long-standing members, no activity yet, some already holding tier roles. */
  function setup(mode: 'highest_only' | 'stack' = 'highest_only') {
    t.services.settings.update(ADMIN, 'test', (s) => {
      s.tiers.mode = mode;
    });
    const role = (name: string) => t.guild.addRole(name, 5);
    const newcomer = t.services.tiers.add(ADMIN, {
      name: 'New Comer',
      roleId: role('New Comer'),
      minTenureDays: 0,
      minActivity: 0,
    });
    const member = t.services.tiers.add(ADMIN, {
      name: 'Member',
      roleId: role('Member'),
      minTenureDays: 30,
      minActivity: 60,
    });
    const trusted = t.services.tiers.add(ADMIN, {
      name: 'Trusted',
      roleId: role('Trusted'),
      minTenureDays: 1825,
      minActivity: 6000,
    });
    const ago = (days: number) => new Date(NOW.getTime() - days * DAY_MS);
    const fresh = t.guild.addMember({ joinedAt: ago(40) });
    const holder = t.guild.addMember({ joinedAt: ago(400), roleIds: [trusted.roleId] });
    const old = t.guild.addMember({ joinedAt: ago(2000), roleIds: [member.roleId] });
    for (const m of [fresh, holder, old]) t.services.members.recordJoin(m, m.joinedAt!);
    return { newcomer, member, trusted, fresh, holder, old };
  }

  it('puts every member exactly in their tenure tier, moving people up and down', async () => {
    const { member, trusted, fresh, holder, old } = setup();
    const s = await t.services.tiers.syncAll('test', { tenureOnly: true });
    expect(s).toMatchObject({ basis: 'tenure', members: 3, changed: 3, errors: 0 });
    expect(fresh.roleIds).toContain(member.roleId); // 40 days → Member, despite 0 activity
    expect(holder.roleIds).toContain(member.roleId); // 400 days → Member...
    expect(holder.roleIds).not.toContain(trusted.roleId); // ...so the Trusted they held is removed
    expect(old.roleIds).toContain(trusted.roleId); // 2000 days → Trusted
    expect(old.roleIds).not.toContain(member.roleId); // highest_only keeps one tier role
    expect(s.byTier).toEqual([
      { name: 'New Comer', gained: 0, lost: 0 },
      { name: 'Member', gained: 2, lost: 1 },
      { name: 'Trusted', gained: 1, lost: 1 },
    ]);
  });

  it('is stable: a second run changes nothing', async () => {
    setup();
    await t.services.tiers.syncAll('test', { tenureOnly: true });
    const again = await t.services.tiers.syncAll('test', { tenureOnly: true });
    expect(again.changed).toBe(0);
  });

  it('keeps every earned tier in stack mode and removes unearned ones', async () => {
    const { newcomer, member, trusted, old, holder } = setup('stack');
    await t.services.tiers.syncAll('test', { tenureOnly: true });
    expect(old.roleIds).toEqual(expect.arrayContaining([newcomer.roleId, member.roleId, trusted.roleId]));
    expect(holder.roleIds).toEqual(expect.arrayContaining([newcomer.roleId, member.roleId]));
    expect(holder.roleIds).not.toContain(trusted.roleId);
  });

  it('preview reports the moves without touching roles or sync history', async () => {
    const { trusted, holder } = setup();
    const s = await t.services.tiers.syncAll('test', { tenureOnly: true, dryRun: true });
    expect(s).toMatchObject({ dryRun: true, changed: 3 });
    expect(t.mod.callsTo('addRole')).toHaveLength(0);
    expect(t.mod.callsTo('removeRole')).toHaveLength(0);
    expect(holder.roleIds).toContain(trusted.roleId);
    expect(t.services.state.get('last_tenure_sync')).toBeNull();
  });

  it('drops grace timers for removed tiers and leaves the regular sync schedule alone', async () => {
    const { holder } = setup();
    await t.services.tiers.evaluateMember(holder); // regular evaluation starts a grace timer on Trusted
    expect(t.db.select().from(memberTierState).all()).toHaveLength(1);
    await t.services.tiers.syncAll('test', { tenureOnly: true });
    expect(t.db.select().from(memberTierState).all()).toHaveLength(0); // Trusted was removed
    expect(t.services.tiers.lastSync()).toBeNull();
    expect(t.services.state.get('last_tenure_sync')).toContain('"basis":"tenure"');
  });

  it('/tiers tenure-sync previews, applies, and warns while demotion is on', async () => {
    setup();
    const owner = t.guild.addMember({ userId: OWNER_ID });
    const run = (rawInput: Record<string, unknown> = {}) =>
      t.executor.run({
        command: t.services.registry.find('tiers tenure-sync')!,
        actor: makeActor(owner),
        source: 'slash',
        rawInput,
      });
    // fresh (40d → Member), holder (400d: Trusted → Member), old (2000d → Trusted), owner (2y → Member)
    const preview = await run({ preview: true });
    expect(preview.result.content).toMatch(/Preview: tenure-only sync of 4 member\(s\): 4 would change/);
    expect(preview.result.content).toMatch(/\*\*Trusted\*\*: \+1 \/ −1/);
    expect(t.mod.callsTo('addRole')).toHaveLength(0);
    const applied = await run();
    expect(applied.result.content).toMatch(/Tenure-only sync of 4 member\(s\): 4 changed/);
    expect(applied.result.content).toMatch(/Demotion is on/);
    t.services.settings.update(ADMIN, 'test', (s) => {
      s.tiers.demotion = false;
    });
    expect((await run()).result.content).not.toMatch(/Demotion is on/);
  });
});

describe('step-by-step demotion with a floor', () => {
  // The server's real ladder: New Comer → Member → Regular → Veteran → Core → Trusted.
  const LADDER: TierDef[] = [
    { id: 1, name: 'New Comer', roleId: 'nc', minTenureDays: 0, minActivity: 0, position: 1 },
    { id: 2, name: 'Member', roleId: 'mem', minTenureDays: 30, minActivity: 60, position: 2 },
    { id: 3, name: 'Regular', roleId: 'reg', minTenureDays: 180, minActivity: 300, position: 3 },
    { id: 4, name: 'Veteran', roleId: 'vet', minTenureDays: 365, minActivity: 1200, position: 4 },
    { id: 5, name: 'Core', roleId: 'core', minTenureDays: 730, minActivity: 3000, position: 5 },
    { id: 6, name: 'Trusted', roleId: 'tr', minTenureDays: 1825, minActivity: 6000, position: 6 },
  ];
  const day = (n: number) => new Date(NOW.getTime() + n * DAY_MS);

  /** Run the planner repeatedly the way the hourly sync would, applying its decisions. */
  function simulate(opts: {
    start: string;
    tenureDays: number;
    score: number;
    floorTierId?: number | null;
    days: number[];
  }) {
    let roles = [opts.start];
    let below = new Map<number, Date>();
    const history: string[] = [];
    for (const d of opts.days) {
      const p = planTiers({
        tiers: LADDER,
        roleIds: roles,
        tenureDays: opts.tenureDays,
        score: opts.score,
        belowSince: below,
        mode: 'highest_only',
        demotion: true,
        graceDays: 7,
        floorTierId: opts.floorTierId ?? null,
        now: day(d),
      });
      roles = [...roles.filter((r) => !p.remove.includes(r)), ...p.add];
      below = p.belowSince;
      history.push(roles.join(','));
    }
    return history;
  }

  it('steps an inactive Core member down one tier per grace period', () => {
    const h = simulate({ start: 'core', tenureDays: 800, score: 0, days: [0, 6, 7, 13, 14, 21, 28, 35] });
    // Grace starts day 0 → Veteran on day 7 (fresh grace) → Regular day 14 → Member day 21 → New Comer day 28.
    expect(h).toEqual(['core', 'core', 'vet', 'vet', 'reg', 'mem', 'nc', 'nc']);
  });

  it('never drops below the floor for members who meet its tenure', () => {
    const h = simulate({
      start: 'core',
      tenureDays: 800,
      score: 0,
      floorTierId: 2,
      days: [0, 7, 14, 21, 28, 60],
    });
    expect(h).toEqual(['core', 'vet', 'reg', 'mem', 'mem', 'mem']);
  });

  it('places members at the floor even with no activity and no tier role', () => {
    const p = planTiers({
      tiers: LADDER,
      roleIds: [],
      tenureDays: 400,
      score: 0,
      belowSince: new Map(),
      mode: 'highest_only',
      demotion: true,
      graceDays: 7,
      floorTierId: 2,
      now: NOW,
    });
    expect(p.add).toEqual(['mem']);
  });

  it('does not apply the floor to members short of its tenure requirement', () => {
    const p = planTiers({
      tiers: LADDER,
      roleIds: [],
      tenureDays: 10,
      score: 0,
      belowSince: new Map(),
      mode: 'highest_only',
      demotion: true,
      graceDays: 7,
      floorTierId: 2,
      now: NOW,
    });
    expect(p.add).toEqual(['nc']);
  });

  it('stops stepping as soon as the member earns the tier again', () => {
    const h = simulate({ start: 'core', tenureDays: 800, score: 1500, days: [0, 7, 14, 21] });
    expect(h).toEqual(['core', 'vet', 'vet', 'vet']); // score 1500 earns Veteran
  });

  it('a held tier at or below the floor is never removed', () => {
    const h = simulate({ start: 'mem', tenureDays: 400, score: 0, floorTierId: 2, days: [0, 30, 90] });
    expect(h).toEqual(['mem', 'mem', 'mem']);
  });

  it('tenure placement still drops straight to the tenure tier', () => {
    const p = planTiers({
      tiers: LADDER,
      roleIds: ['tr'],
      tenureDays: 400,
      score: Number.POSITIVE_INFINITY,
      belowSince: new Map(),
      mode: 'highest_only',
      demotion: true,
      graceDays: 0,
      stepwise: false,
      now: NOW,
    });
    expect(p).toMatchObject({ add: ['vet'], remove: ['tr'] });
  });

  it('/tiers settings sets and clears the floor', async () => {
    const owner = t.guild.addMember({ userId: OWNER_ID });
    const role = t.guild.addRole('Member', 5);
    const member = t.services.tiers.add(ADMIN, {
      name: 'Member',
      roleId: role,
      minTenureDays: 30,
      minActivity: 60,
    });
    const run = (rawInput: Record<string, unknown>) =>
      t.executor.run({
        command: t.services.registry.find('tiers settings')!,
        actor: makeActor(owner),
        source: 'slash',
        rawInput,
      });
    const set = await run({ floor: 'member' });
    expect(set.result.content).toMatch(/Floor: Member/);
    expect(t.services.settings.get().tiers.demotionFloorTierId).toBe(member.id);
    await run({ floor: 'none' });
    expect(t.services.settings.get().tiers.demotionFloorTierId).toBeNull();
    expect((await run({ floor: 'nope' })).result.ok).toBe(false);
  });

  it('the service applies the configured floor during a regular sync', async () => {
    const role = (name: string) => t.guild.addRole(name, 5);
    t.services.tiers.add(ADMIN, {
      name: 'New Comer',
      roleId: role('New Comer'),
      minTenureDays: 0,
      minActivity: 0,
    });
    const member = t.services.tiers.add(ADMIN, {
      name: 'Member',
      roleId: role('Member'),
      minTenureDays: 30,
      minActivity: 60,
    });
    t.services.settings.update(ADMIN, 'test', (s) => {
      s.tiers.demotionFloorTierId = member.id;
    });
    const m = t.guild.addMember({ joinedAt: new Date(NOW.getTime() - 400 * DAY_MS) });
    t.services.members.recordJoin(m, m.joinedAt!);
    await t.services.tiers.syncAll('test');
    expect(m.roleIds).toContain(member.roleId); // no activity, but 400 days of tenure → floor
  });
});
