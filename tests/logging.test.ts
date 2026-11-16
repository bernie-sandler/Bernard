import { desc } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { logs } from '../src/db/schema.js';
import { type ChannelSnapshot, diffChannel, diffRole, type RoleSnapshot } from '../src/services/eventLog.js';
import { type CachedMessage, MessageCache } from '../src/services/messageCache.js';
import { AUDIT, mapAuditEntry } from '../src/services/moderation/external.js';
import { makeActor, OWNER_ID, sid, testContainer } from './helpers.js';

const BOT = '555555555555555555';

describe('mapAuditEntry', () => {
  const base = {
    executorId: '111111111111111111',
    targetId: '222222222222222222',
    reason: 'r',
    changes: [],
    createdAt: new Date('2026-01-01T00:00:00Z'),
  };

  it.each([
    [AUDIT.MemberBanAdd, 'ban'],
    [AUDIT.MemberBanRemove, 'unban'],
    [AUDIT.MemberKick, 'kick'],
  ])('maps action %i to %s', (action, expected) => {
    expect(mapAuditEntry({ ...base, action }, BOT)).toMatchObject({
      action: expected,
      moderatorId: base.executorId,
    });
  });

  it('maps timeouts with a duration and timeout removals', () => {
    const timeout = mapAuditEntry(
      {
        ...base,
        action: AUDIT.MemberUpdate,
        changes: [{ key: 'communication_disabled_until', new: '2026-01-01T01:00:00Z' }],
      },
      BOT,
    );
    expect(timeout).toMatchObject({ action: 'timeout', durationMs: 3_600_000 });
    const removed = mapAuditEntry(
      {
        ...base,
        action: AUDIT.MemberUpdate,
        changes: [{ key: 'communication_disabled_until', old: '2026-01-01T01:00:00Z' }],
      },
      BOT,
    );
    expect(removed).toMatchObject({ action: 'untimeout' });
  });

  it('ignores the bot itself, unrelated updates and unknown actions', () => {
    expect(mapAuditEntry({ ...base, action: AUDIT.MemberBanAdd, executorId: BOT }, BOT)).toBeNull();
    expect(
      mapAuditEntry({ ...base, action: AUDIT.MemberUpdate, changes: [{ key: 'nick', new: 'x' }] }, BOT),
    ).toBeNull();
    expect(mapAuditEntry({ ...base, action: 1 }, BOT)).toBeNull();
    expect(mapAuditEntry({ ...base, action: AUDIT.MemberKick, targetId: null }, BOT)).toBeNull();
  });
});

describe('MessageCache', () => {
  const m = (id: string, content = 'hi'): CachedMessage => ({
    id,
    channelId: 'c',
    authorId: 'a',
    authorTag: 'a#0',
    content,
    attachments: [],
    createdAt: 0,
  });

  it('evicts the least recently used entry when full', () => {
    const cache = new MessageCache(100);
    for (let i = 0; i < 101; i++) cache.set(m(String(i)));
    expect(cache.size).toBe(100);
    expect(cache.get('0')).toBeUndefined();
    expect(cache.get('100')).toBeDefined();
  });

  it('resizes keeping the newest entries, and take() removes', () => {
    const cache = new MessageCache(300);
    for (let i = 0; i < 300; i++) cache.set(m(String(i)));
    cache.resize(100);
    expect(cache.size).toBe(100);
    expect(cache.get('299')).toBeDefined();
    expect(cache.get('150')).toBeUndefined();
    cache.updateContent('299', 'edited');
    expect(cache.take('299')?.content).toBe('edited');
    expect(cache.get('299')).toBeUndefined();
  });
});

describe('diffs', () => {
  const role: RoleSnapshot = {
    id: '1',
    name: 'Mod',
    color: 0xff0000,
    hoist: false,
    mentionable: false,
    permissions: ['KickMembers'],
  };
  const ch: ChannelSnapshot = {
    id: '1',
    name: 'general',
    kind: 'text',
    topic: null,
    nsfw: false,
    rateLimitPerUser: 0,
    parentId: null,
    userLimit: 0,
    overwrites: 'a',
  };

  it('describes role changes', () => {
    expect(diffRole(role, role)).toEqual([]);
    expect(
      diffRole(role, { ...role, name: 'Moderator', color: 0x00ff00, permissions: ['BanMembers'] }),
    ).toEqual([
      'Name: Mod → Moderator',
      'Color: #ff0000 → #00ff00',
      'Permissions granted: BanMembers',
      'Permissions revoked: KickMembers',
    ]);
  });

  it('describes channel changes', () => {
    expect(diffChannel(ch, ch)).toEqual([]);
    expect(diffChannel(ch, { ...ch, topic: 'hello', rateLimitPerUser: 5, overwrites: 'b' })).toEqual([
      'Topic: (none) → hello',
      'Slowmode: 0s → 5s',
      'Permission overwrites changed',
    ]);
  });
});

describe('EventLogService', () => {
  let t: ReturnType<typeof testContainer>;
  const MEMBERS = '900000000000000020';
  const MESSAGES = '900000000000000021';
  beforeEach(() => {
    t = testContainer();
    t.services.settings.update({ id: OWNER_ID, source: 'system' }, 'test', (s) => {
      s.logs.channels.members = MEMBERS;
      s.logs.channels.messages = MESSAGES;
      s.logs.newAccountDays = 7;
    });
  });
  afterEach(() => t.close());
  const last = () => t.db.select().from(logs).orderBy(desc(logs.id)).get()!;

  it('flags new accounts on join and routes to the members channel', async () => {
    await t.services.eventLog.memberJoined({
      userId: sid(),
      tag: 'newbie',
      avatarUrl: null,
      accountCreatedAt: new Date(Date.now() - 2 * 86_400_000),
      memberCount: 10,
      isBot: false,
    });
    expect(last()).toMatchObject({
      type: 'members',
      event: 'member_join',
      data: { newAccount: true, accountAgeDays: 2 },
    });
    expect(t.messenger.sent.at(-1)).toMatchObject({
      channelId: MEMBERS,
      embed: { title: 'Member joined ⚠️' },
    });
  });

  it('stores entries for types without a channel but does not post them', async () => {
    await t.services.eventLog.voiceChanged({ userId: sid(), tag: 'x', from: null, to: sid() });
    expect(last()).toMatchObject({ type: 'voice', event: 'voice_join' });
    expect(t.messenger.sent).toHaveLength(0);
  });

  it('labels voice moves and leaves, and ignores no-op changes', async () => {
    const a = sid();
    const b = sid();
    await t.services.eventLog.voiceChanged({ userId: sid(), tag: 'x', from: a, to: b });
    expect(last().event).toBe('voice_move');
    await t.services.eventLog.voiceChanged({ userId: sid(), tag: 'x', from: a, to: null });
    expect(last().event).toBe('voice_leave');
    const count = t.db.select().from(logs).all().length;
    await t.services.eventLog.voiceChanged({ userId: sid(), tag: 'x', from: a, to: a });
    expect(t.db.select().from(logs).all()).toHaveLength(count);
  });

  it('skips embed-only edits and handles uncached deletes', async () => {
    const base = { messageId: sid(), channelId: sid(), authorId: sid(), authorTag: 'x', url: 'u' };
    await t.services.eventLog.messageEdited({ ...base, before: 'same', after: 'same' });
    expect(t.db.select().from(logs).all()).toHaveLength(0);
    await t.services.eventLog.messageEdited({ ...base, before: null, after: 'new' });
    expect(t.messenger.sent.at(-1)!.embed.fields![0]).toEqual({ name: 'Before', value: '*(not cached)*' });
    await t.services.eventLog.messageDeleted({ messageId: sid(), channelId: sid(), cached: null });
    expect(last()).toMatchObject({ event: 'message_delete', data: { cached: false, content: null } });
  });

  it('recognises log channels', () => {
    expect(t.services.eventLog.isLogChannel(MEMBERS)).toBe(true);
    expect(t.services.eventLog.isLogChannel(sid())).toBe(false);
    expect(t.services.eventLog.isLogChannel(null)).toBe(false);
  });

  it('prunes logs older than the retention period', async () => {
    await t.services.eventLog.voiceChanged({ userId: sid(), tag: 'x', from: null, to: sid() });
    expect(t.services.logs.prune(new Date(Date.now() + 29 * 86_400_000))).toBe(0);
    expect(t.services.logs.prune(new Date(Date.now() + 31 * 86_400_000))).toBe(1);
  });
});

describe('/logs and moderation commands', () => {
  let t: ReturnType<typeof testContainer>;
  beforeEach(() => {
    t = testContainer();
  });
  afterEach(() => t.close());

  const run = (name: string, rawInput: Record<string, unknown>) => {
    const owner =
      t.guild.members.get(OWNER_ID) ?? t.guild.addMember({ userId: OWNER_ID, highestRolePosition: 99 });
    return t.executor.run({
      command: t.services.registry.find(name)!,
      actor: makeActor(owner),
      source: 'slash',
      channelId: '800000000000000001',
      rawInput,
    });
  };

  it('/logs set verifies the bot can post before saving', async () => {
    const ch = sid();
    t.messenger.fail = true;
    const bad = await run('logs set', { type: 'members', channel: ch });
    expect(bad.result).toMatchObject({ ok: false, content: expect.stringMatching(/can't post/) });
    expect(t.services.settings.get().logs.channels.members).toBeNull();
    t.messenger.fail = false;
    await run('logs set', { type: 'members', channel: ch });
    expect(t.services.settings.get().logs.channels.members).toBe(ch);
    await run('logs disable', { type: 'members' });
    expect(t.services.settings.get().logs.channels.members).toBeNull();
  });

  it('/logs set rejects unknown types', async () => {
    const res = await run('logs set', { type: 'nope', channel: sid() });
    expect(res.outcome).toBe('invalid');
  });

  it('/logs config requires at least one option and audits changes', async () => {
    expect((await run('logs config', {})).result.ok).toBe(false);
    await run('logs config', { retention_days: 14 });
    expect(t.services.settings.get().logs.retentionDays).toBe(14);
    expect(t.services.audit.list()[0]).toMatchObject({ action: 'settings.logs.config', source: 'slash' });
  });

  it('/purge defaults to the current channel and reports skipped messages', async () => {
    const ch = '800000000000000001';
    t.guild.channels.set(ch, { id: ch, name: 'general', kind: 'text', parentId: null });
    t.mod.messages.set(ch, [
      { id: sid(), authorId: 'a', createdAt: new Date(), pinned: false },
      { id: sid(), authorId: 'a', createdAt: new Date(Date.now() - 20 * 86_400_000), pinned: false },
    ]);
    const res = await run('purge', { amount: 2 });
    expect(res.result.content).toMatch(/Deleted 1 message\(s\) in <#800000000000000001>/);
    expect(res.result.content).toMatch(/1 skipped because they are older than 14 days/);
  });

  it('/ban parses durations and replies with the case number', async () => {
    const target = t.guild.addMember();
    const res = await run('ban', { user: target.userId, duration: '7d', reason: 'spam' });
    expect(res.result.content).toMatch(/Banned <@\d+> for 7d\. Case #1/);
  });

  it('/case shows a case and errors for unknown ones', async () => {
    const target = t.guild.addMember();
    await run('warn', { user: target.userId, reason: 'be nice' });
    expect((await run('case', { id: 1 })).result.embeds![0]!.title).toBe('Case #1 • Warning');
    expect((await run('case', { id: 99 })).result.ok).toBe(false);
  });

  it('/userinfo hides moderation details from members without admin:warnings', async () => {
    const viewer = t.guild.addMember();
    const res = await t.executor.run({
      command: t.services.registry.find('userinfo')!,
      actor: makeActor(viewer),
      source: 'slash',
      rawInput: {},
    });
    expect(JSON.stringify(res.result.embeds)).not.toContain('Moderation');
    const asOwner = await run('userinfo', { user: viewer.userId });
    expect(JSON.stringify(asOwner.result.embeds)).toContain('Moderation');
  });
});
