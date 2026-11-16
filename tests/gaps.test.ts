/**
 * Tests that close coverage gaps found in phase 7: the job scheduler, the Discord OAuth client,
 * Discord error messages, API error mapping, member-action routes, and the moderation and voice
 * command wrappers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DiscordOAuthClient } from '../src/api/oauth.js';
import { describeDiscordError } from '../src/discord/errors.js';
import { Scheduler } from '../src/jobs/scheduler.js';
import { nullLogger } from '../src/logger.js';
import { apiHarness } from './apiHarness.js';
import { makeActor, OWNER_ID, sid, testContainer } from './helpers.js';

describe('Scheduler', () => {
  afterEach(() => vi.useRealTimers());

  it('runs jobs on trigger, records errors instead of throwing, and stops', async () => {
    const s = new Scheduler(nullLogger);
    let runs = 0;
    s.add('ok', '0 0 1 1 *', () => {
      runs++;
    });
    s.add('bad', '0 0 1 1 *', () => {
      throw new Error('boom');
    });
    await s.trigger('ok');
    await s.trigger('bad');
    expect(runs).toBe(1);
    const status = Object.fromEntries(s.status().map((j) => [j.name, j]));
    expect(status.ok).toMatchObject({ lastError: null, lastRunAt: expect.any(Date) });
    expect(status.bad).toMatchObject({ lastError: 'boom' });
    expect(status.ok!.nextRunAt).toBeInstanceOf(Date);
    expect(() => s.add('ok', '* * * * *', () => {})).toThrow('already registered');
    await expect(s.trigger('nope')).rejects.toThrow('Unknown job');
    s.stop();
    expect(s.status()).toEqual([]);
  });

  it('does not overlap a run that is still in progress', async () => {
    const s = new Scheduler(nullLogger);
    let active = 0;
    let maxActive = 0;
    let release!: () => void;
    s.add('slow', '0 0 1 1 *', async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise<void>((r) => {
        release = r;
      });
      active--;
    });
    const first = s.trigger('slow');
    const second = s.trigger('slow');
    await new Promise((r) => setTimeout(r, 20));
    release();
    await new Promise((r) => setTimeout(r, 20));
    release(); // in case the second trigger was queued rather than skipped
    await Promise.all([first, second]);
    expect(maxActive).toBe(1);
    s.stop();
  });
});

describe('DiscordOAuthClient', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('builds an identify-only authorize URL', () => {
    const c = new DiscordOAuthClient('123', 'secret', 'https://bot.example.com/api/auth/callback');
    const url = new URL(c.authorizeUrl('st'));
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: '123',
      redirect_uri: 'https://bot.example.com/api/auth/callback',
      response_type: 'code',
      scope: 'identify',
      state: 'st',
      prompt: 'none',
    });
  });

  it('exchanges the code, fetches the user and revokes the token', async () => {
    const calls: { url: string; body?: string }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, body: init?.body?.toString() });
        if (url.endsWith('/oauth2/token')) return Response.json({ access_token: 'tok' });
        if (url.endsWith('/users/@me'))
          return Response.json({ id: '1', username: 'a', global_name: null, avatar: null });
        return new Response(null, { status: 200 });
      }),
    );
    const c = new DiscordOAuthClient('123', 'secret', 'https://x/cb');
    expect(await c.identify('code')).toMatchObject({ id: '1' });
    expect(calls[0]!.body).toContain('grant_type=authorization_code');
    expect(calls[0]!.body).toContain('code=code');
    await vi.waitFor(() => expect(calls.some((x) => x.url.endsWith('/oauth2/token/revoke'))).toBe(true));
  });

  it('throws when Discord rejects the code', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 400 })),
    );
    await expect(new DiscordOAuthClient('1', 's', 'r').identify('bad')).rejects.toThrow(
      'Token exchange failed (400)',
    );
  });
});

describe('describeDiscordError', () => {
  it.each([
    [{ code: 50013, status: 403 }, /missing a Discord permission/],
    [{ code: 10007, status: 404 }, /not in the server/],
    [{ code: 99999, status: 429 }, /rate limiting/],
    [{ code: 99999, status: 503 }, /having problems/],
    [{ code: 99999, status: 400 }, /rejected that action/],
  ])('%j', (err, msg) => {
    expect(describeDiscordError(err)).toMatch(msg);
  });

  it('ignores non-Discord errors', () => {
    expect(describeDiscordError(new Error('x'))).toBeNull();
    expect(describeDiscordError('x')).toBeNull();
  });
});

describe('member action routes and API errors', () => {
  let h: Awaited<ReturnType<typeof apiHarness>>;
  beforeEach(async () => {
    h = await apiHarness();
  });
  afterEach(() => h.close());

  it('timeout, untimeout, kick, ban and roles create dashboard cases', async () => {
    const c = await h.owner();
    const m = h.t.guild.addMember();
    const role = h.t.guild.addRole('Helper', 3);
    const post = (action: string, body: unknown) =>
      c.send('POST', `/api/members/${m.userId}/${action}`, body);
    expect((await post('timeout', { duration: '1h', reason: 'calm down' })).json()).toMatchObject({
      caseNumber: 1,
    });
    expect((await post('untimeout', {})).json()).toMatchObject({ caseNumber: 2 });
    expect((await post('roles', { roleId: role, add: true })).json()).toMatchObject({
      message: 'Role added.',
    });
    expect((await post('roles', { roleId: role, add: false })).json()).toMatchObject({
      message: 'Role removed.',
    });
    expect((await post('kick', { reason: 'bye' })).json()).toMatchObject({ caseNumber: 5 });
    const ban = (await c.send('POST', `/api/members/${sid()}/ban`, { duration: '7d', deleteDays: 1 })).json();
    expect(ban).toMatchObject({ caseNumber: 6, message: 'Banned for 7d.' });
    expect(h.t.services.moderation.cases.list({ limit: 10 }).every((x) => x.source === 'dashboard')).toBe(
      true,
    );
    expect((await c.get('/api/cases/6')).json().case).toMatchObject({
      label: 'Ban',
      durationMs: 7 * 86_400_000,
    });
    expect((await c.get('/api/cases/99')).statusCode).toBe(404);
  });

  it('maps Discord API errors to 502 and unexpected errors to 500', async () => {
    const c = await h.owner();
    const m = h.t.guild.addMember();
    h.t.mod.kick = async () => {
      throw Object.assign(new Error('Missing Permissions'), { code: 50013, status: 403 });
    };
    const discord = await c.send('POST', `/api/members/${m.userId}/kick`, {});
    expect(discord.statusCode).toBe(502);
    expect(discord.json().error).toMatch(/missing a Discord permission/);
    h.t.mod.kick = async () => {
      throw new Error('secret internals');
    };
    const internal = await c.send('POST', `/api/members/${m.userId}/kick`, {});
    expect(internal.statusCode).toBe(500);
    expect(internal.json().error).not.toMatch(/secret/);
  });

  it('filters logs by user, channel and date', async () => {
    const c = await h.owner();
    const user = sid();
    const ch = sid();
    await h.t.services.logs.record({
      type: 'voice',
      event: 'voice_join',
      actorId: user,
      channelId: ch,
      summary: 'joined',
    });
    await h.t.services.logs.record({ type: 'voice', event: 'voice_join', actorId: sid(), summary: 'other' });
    expect((await c.get(`/api/logs?user=${user}`)).json().items).toHaveLength(1);
    expect((await c.get(`/api/logs?channel=${ch}`)).json().items).toHaveLength(1);
    const future = new Date(Date.now() + 86_400_000).toISOString();
    expect((await c.get(`/api/logs?from=${future}`)).json().items).toHaveLength(0);
    const page = (await c.get('/api/logs?limit=1')).json();
    expect(page.nextBefore).not.toBeNull();
  });
});

describe('moderation command wrappers', () => {
  let t: ReturnType<typeof testContainer>;
  beforeEach(() => {
    t = testContainer();
  });
  afterEach(() => t.close());
  const run = (name: string, rawInput: Record<string, unknown> = {}, channelId = '800000000000000001') => {
    const owner =
      t.guild.members.get(OWNER_ID) ?? t.guild.addMember({ userId: OWNER_ID, highestRolePosition: 99 });
    return t.executor.run({
      command: t.services.registry.find(name)!,
      actor: makeActor(owner),
      source: 'slash',
      channelId,
      rawInput,
    });
  };

  it('replies with what happened for each action', async () => {
    const m = t.guild.addMember();
    const role = t.guild.addRole('Helper', 3);
    const ch = '800000000000000001';
    t.guild.channels.set(ch, { id: ch, name: 'general', kind: 'text', parentId: null });
    const news = t.guild.addChannel('news', 'announcement');
    const expectations: [string, Record<string, unknown>, RegExp][] = [
      ['kick', { user: m.userId, reason: 'r' }, /Kicked <@\d+>\. Case #1/],
      ['unban', { user: m.userId }, /Unbanned|not banned/],
      ['slowmode', { seconds: 10 }, /Slowmode in <#\d+> set to 10s/],
      ['slowmode', { seconds: 0 }, /turned off/],
      ['lock', {}, /Locked <#\d+>/],
      ['unlock', {}, /Unlocked <#\d+>/],
      ['announce', { channel: news, message: 'Hello', embed: true, title: 'News' }, /Posted in <#\d+>/],
    ];
    for (const [name, input, expected] of expectations) {
      expect((await run(name, input)).result.content).toMatch(expected);
    }
    const m2 = t.guild.addMember();
    expect((await run('timeout', { user: m2.userId, duration: '10m' })).result.content).toMatch(
      /Timed out .* for 10m/,
    );
    expect((await run('untimeout', { user: m2.userId })).result.content).toMatch(/Removed the timeout/);
    expect((await run('role add', { user: m2.userId, role })).result.content).toMatch(/Gave <@&\d+> to/);
    expect((await run('role remove', { user: m2.userId, role })).result.content).toMatch(
      /Removed <@&\d+> from/,
    );
    expect((await run('nick', { user: m2.userId, nickname: 'Neo' })).result.content).toMatch(
      /Renamed .* to \*\*Neo\*\*/,
    );
    expect((await run('nick', { user: m2.userId })).result.content).toMatch(/Reset/);
    await run('warn', { user: m2.userId, reason: 'one' });
    const list = (await run('warnings list', { user: m2.userId })).result;
    expect(list.embeds![0]!.title).toBe('Warnings (1)');
    const caseNumber = t.services.moderation.listWarnings(m2.userId)[0]!.caseNumber;
    expect((await run('warnings remove', { case: caseNumber })).result.content).toMatch(/Removed warning/);
    expect((await run('warnings list', { user: m2.userId })).result.content).toMatch(/no active warnings/);
  });
});

describe('voice command wrappers', () => {
  let t: ReturnType<typeof testContainer>;
  let owner: ReturnType<typeof t.guild.addMember>;
  let temp: string;
  beforeEach(async () => {
    t = testContainer();
    owner = t.guild.addMember({ userId: OWNER_ID, highestRolePosition: 99 });
    const cat = t.voice.addVoiceChannel('Temp', 'category');
    const hub = t.voice.addVoiceChannel('Join');
    t.services.voice.addHub(
      { id: OWNER_ID, source: 'system' },
      { channelId: hub, type: 'public', categoryId: cat },
    );
    t.voice.states.set(OWNER_ID, hub);
    await t.services.voice.handleVoiceStateUpdate({
      userId: OWNER_ID,
      displayName: 'O',
      username: 'o',
      isBot: false,
      from: null,
      to: hub,
    });
    temp = t.voice.states.get(OWNER_ID)!;
    await t.services.voice.handleVoiceStateUpdate({
      userId: OWNER_ID,
      displayName: 'O',
      username: 'o',
      isBot: false,
      from: hub,
      to: temp,
    });
  });
  afterEach(() => {
    t.services.voice.stop();
    t.close();
  });
  const run = (name: string, rawInput: Record<string, unknown> = {}) =>
    t.executor.run({
      command: t.services.registry.find(name)!,
      actor: makeActor(owner),
      source: 'slash',
      rawInput,
    });

  it('/vc commands act on the owner’s channel', async () => {
    const guest = sid();
    t.voice.states.set(guest, temp);
    expect((await run('vc lock')).result.content).toMatch(/is locked/);
    expect((await run('vc unlock')).result.content).toMatch(/open to everyone/);
    expect((await run('vc limit', { limit: 4 })).result.content).toMatch(/allows 4 users/);
    expect((await run('vc limit', { limit: 0 })).result.content).toMatch(/no user limit/);
    expect((await run('vc rename', { name: 'Chill' })).result.content).toMatch(/Renamed/);
    expect((await run('vc invite', { user: sid() })).result.content).toMatch(/can now join/);
    expect((await run('vc kick', { user: guest })).result.content).toMatch(/can't rejoin/);
    expect((await run('vc kick', { user: sid() })).result.content).toMatch(/is blocked from/);
    const other = sid();
    t.voice.states.set(other, temp);
    expect((await run('vc transfer', { user: other })).result.content).toMatch(/now owns/);
    expect((await run('vc claim')).result.content).toMatch(/still here/);
  });

  it('/voice hub commands manage hubs', async () => {
    const cat = t.voice.addVoiceChannel('Cat2', 'category');
    const hub2 = t.voice.addVoiceChannel('Private join');
    expect(
      (
        await run('voice hub add', {
          channel: hub2,
          type: 'private',
          category: cat,
          hide: true,
          default_limit: 3,
        })
      ).result.content,
    ).toMatch(/Hub created: <#\d+> \*\*private\*\*.*limit 3.*hidden/);
    expect(
      (await run('voice hub edit', { channel: hub2, name_template: '{username} room' })).result.content,
    ).toMatch(/"{username} room"/);
    const list = (await run('voice hub list')).result.embeds![0]!;
    expect(list.description).toMatch(/private/);
    expect(list.fields![0]!.name).toBe('Active channels (1)');
    expect((await run('voice hub remove', { channel: hub2 })).result.content).toMatch(/no longer a hub/);
    expect((await run('voice settings', {})).result.ok).toBe(false);
  });
});
