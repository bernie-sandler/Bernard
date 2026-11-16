import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SESSION_COOKIE, STATE_COOKIE } from '../src/api/auth.js';
import type { OAuthClient } from '../src/api/oauth.js';
import { type ApiServer, createApiServer } from '../src/api/server.js';
import { loadEnv } from '../src/config/env.js';
import { nullLogger } from '../src/logger.js';
import { type LiveTopic, topicForAudit } from '../src/services/liveEvents.js';
import { GUILD_ID, OWNER_ID, sid, testContainer } from './helpers.js';

const ADMIN = { id: OWNER_ID, source: 'system' as const };

describe('topicForAudit', () => {
  it.each([
    ['permissions.set', 'permissions'],
    ['permissions.unset', 'permissions'],
    ['tiers.add', 'tiers'],
    ['settings.tiers', 'tiers'],
    ['settings.logs', 'settings'],
    ['voice.hub.edit', 'hubs'],
    ['dashboard.member.ban', null],
  ])('%s → %s', (action, topic) => {
    expect(topicForAudit(action)).toBe(topic);
  });
});

describe('services publish live topics', () => {
  let t: ReturnType<typeof testContainer>;
  let seen: LiveTopic[];
  beforeEach(() => {
    t = testContainer();
    seen = [];
    t.services.live.subscribe((topic) => seen.push(topic));
  });
  afterEach(() => {
    t.services.voice.stop();
    t.close();
  });

  it('config changes, logs, temp voice and tier syncs', async () => {
    const role = t.guild.addRole('Mod', 5);
    t.services.permissions.setRule(ADMIN, role, 'admin:*', true);
    t.services.settings.update(ADMIN, 'settings.logs', (s) => {
      s.logs.retentionDays = 10;
    });
    t.services.settings.update(ADMIN, 'settings.tiers', (s) => {
      s.tiers.demotion = false;
    });
    await t.services.logs.record({ type: 'members', event: 'member_join', summary: 'x' });
    expect(seen).toEqual(['permissions', 'settings', 'tiers', 'members']);

    seen.length = 0;
    const cat = t.voice.addVoiceChannel('Temp', 'category');
    const hub = t.voice.addVoiceChannel('Join');
    t.services.voice.addHub(ADMIN, { channelId: hub, type: 'public', categoryId: cat });
    expect(seen).toEqual(['hubs']);
    const user = sid();
    t.voice.states.set(user, hub);
    await t.services.voice.handleVoiceStateUpdate({
      userId: user,
      displayName: 'U',
      username: 'u',
      isBot: false,
      from: null,
      to: hub,
    });
    expect(seen).toContain('tempVoice');

    seen.length = 0;
    t.services.tiers.add(ADMIN, { name: 'All', roleId: role, minTenureDays: 0, minActivity: 0 });
    await t.services.tiers.syncAll('test');
    expect(seen.filter((x) => x === 'tiers')).toHaveLength(2); // tiers.add audit + sync finished
  });
});

describe('GET /api/events', () => {
  const env = loadEnv({
    DISCORD_TOKEN: 'x'.repeat(70),
    DISCORD_CLIENT_ID: '123456789012345678',
    GUILD_ID,
    DISCORD_CLIENT_SECRET: 'secret',
    SESSION_SECRET: 's'.repeat(40),
    PUBLIC_BASE_URL: 'http://127.0.0.1',
  });
  const oauth: OAuthClient = {
    authorizeUrl: (state) => `https://discord.com/oauth2/authorize?state=${state}`,
    identify: async () => ({ id: OWNER_ID, username: 'owner', global_name: null, avatar: null }),
  };
  let t: ReturnType<typeof testContainer>;
  let app: ApiServer;
  let base: string;
  const streams: AbortController[] = [];

  beforeEach(async () => {
    t = testContainer();
    t.guild.addMember({ userId: OWNER_ID, highestRolePosition: 99 });
    app = await createApiServer({
      env,
      logger: nullLogger,
      container: t,
      startedAt: new Date(),
      oauth,
      webRoot: 'none',
      live: { heartbeatMs: 40, coalesceMs: 30, maxPerUser: 2 },
    });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const addr = app.server.address();
    base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  });
  afterEach(async () => {
    for (const c of streams.splice(0)) c.abort();
    await app.close();
    t.close();
  });

  async function sessionCookie(): Promise<string> {
    const start = await app.inject({ method: 'GET', url: '/api/auth/login' });
    const state = new URL(start.headers.location as string).searchParams.get('state')!;
    const stateCookie = start.cookies.find((c) => c.name === STATE_COOKIE)!.value;
    const cb = await app.inject({
      method: 'GET',
      url: `/api/auth/callback?code=x&state=${state}`,
      cookies: { [STATE_COOKIE]: stateCookie },
    });
    return cb.cookies.find((c) => c.name === SESSION_COOKIE)!.value;
  }

  /** Open the stream and return a reader that collects text until a predicate matches. */
  async function open(cookie: string) {
    const ctrl = new AbortController();
    streams.push(ctrl);
    const res = await fetch(`${base}/api/events`, {
      headers: { cookie: `${SESSION_COOKIE}=${cookie}` },
      signal: ctrl.signal,
    });
    const reader = res.body?.getReader();
    let text = '';
    const until = async (match: (s: string) => boolean, timeoutMs = 2000) => {
      const deadline = Date.now() + timeoutMs;
      while (!match(text)) {
        if (Date.now() > deadline) throw new Error(`timed out; got: ${JSON.stringify(text)}`);
        const { value, done } = await reader!.read();
        if (done) return { text, done: true };
        text += new TextDecoder().decode(value);
      }
      return { text, done: false };
    };
    return { res, until };
  }

  it('rejects requests without a session', async () => {
    const res = await fetch(`${base}/api/events`);
    expect(res.status).toBe(401);
  });

  it('streams coalesced topic signals after a ready event', async () => {
    const cookie = await sessionCookie();
    const s = await open(cookie);
    expect(s.res.headers.get('content-type')).toMatch(/text\/event-stream/);
    expect(s.res.headers.get('x-accel-buffering')).toBe('no');
    await s.until((x) => x.includes('event: ready'));
    t.services.live.publish('members');
    t.services.live.publish('moderation');
    t.services.live.publish('members');
    const { text } = await s.until((x) => x.includes('data: {"topics"'));
    const line = text.split('\n').find((l) => l.startsWith('data: {"topics"'))!;
    expect(JSON.parse(line.slice(6)).topics.sort()).toEqual(['members', 'moderation']);
    await s.until((x) => x.includes(': ping'));
  });

  it('limits open streams per user', async () => {
    const cookie = await sessionCookie();
    await (await open(cookie)).until((x) => x.includes('ready'));
    await (await open(cookie)).until((x) => x.includes('ready'));
    const third = await fetch(`${base}/api/events`, { headers: { cookie: `${SESSION_COOKIE}=${cookie}` } });
    expect(third.status).toBe(429);
  });

  it('ends the stream when the session ends or access is removed', async () => {
    const cookie = await sessionCookie();
    const s = await open(cookie);
    await s.until((x) => x.includes('ready'));
    t.services.sessions.prune(Date.now() + 365 * 86_400_000); // expire every session
    const r = await s.until(() => false, 1000).catch(() => ({ done: false }));
    expect(r.done).toBe(true);
  });

  it('shuts down cleanly with streams open', async () => {
    const cookie = await sessionCookie();
    await (await open(cookie)).until((x) => x.includes('ready'));
    const started = Date.now();
    await app.close();
    expect(Date.now() - started).toBeLessThan(1500);
    expect(t.services.live.listenerCount).toBe(0);
  });
});
