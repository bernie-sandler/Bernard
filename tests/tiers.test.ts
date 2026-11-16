import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { activityDaily, logs } from '../src/db/schema.js';
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
  it('awards one point per message with a per-user cooldown', () => {
    const a = t.services.activity;
    expect(a.recordMessage('u1')).toBe(true);
    expect(a.recordMessage('u1')).toBe(false);
    expect(a.recordMessage('u2')).toBe(true);
    vi.advanceTimersByTime(60_000);
    expect(a.recordMessage('u1')).toBe(true);
    expect(a.totals('u1')).toEqual({ messagePoints: 2, voiceMinutes: 0, score: 2 });
  });

  it('applies weights at read time and only counts the rolling window', () => {
    const a = t.services.activity;
    t.db
      .insert(activityDaily)
      .values([
        { guildId: GUILD_ID, userId: 'u1', date: dateKey(NOW.getTime()), messagePoints: 3, voiceMinutes: 10 },
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
    expect(a.totals('u1')).toEqual({ messagePoints: 4, voiceMinutes: 10, score: 14 });
    t.services.settings.update(ADMIN, 'test', (s) => {
      s.activity.pointsPerMessage = 2;
      s.activity.pointsPerVoiceMinute = 0.5;
    });
    expect(a.totals('u1').score).toBe(13);
    expect(a.allTotals()[0]).toMatchObject({ userId: 'u1', score: 13 });
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
