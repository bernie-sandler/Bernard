import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SESSION_COOKIE, STATE_COOKIE } from '../src/api/auth.js';
import type { DiscordUser, OAuthClient } from '../src/api/oauth.js';
import { type ApiServer, createApiServer } from '../src/api/server.js';
import { loadEnv } from '../src/config/env.js';
import { nullLogger } from '../src/logger.js';
import { GUILD_ID, OWNER_ID, sid, testContainer } from './helpers.js';

const BASE = 'https://bot.example.com';
const env = loadEnv({
  DISCORD_TOKEN: 'x'.repeat(70),
  DISCORD_CLIENT_ID: '123456789012345678',
  GUILD_ID,
  DISCORD_CLIENT_SECRET: 'secret',
  SESSION_SECRET: 's'.repeat(40),
  PUBLIC_BASE_URL: BASE,
  TRUST_PROXY: '1',
});

class FakeOAuth implements OAuthClient {
  users = new Map<string, DiscordUser>();
  authorizeUrl(state: string) {
    return `https://discord.com/oauth2/authorize?state=${state}`;
  }
  async identify(code: string) {
    const u = this.users.get(code);
    if (!u) throw new Error('bad code');
    return u;
  }
}

let t: ReturnType<typeof testContainer>;
let app: ApiServer;
let oauth: FakeOAuth;

beforeEach(async () => {
  t = testContainer();
  oauth = new FakeOAuth();
  app = await createApiServer({
    env,
    logger: nullLogger,
    container: t,
    startedAt: new Date(),
    oauth,
    webRoot: 'nonexistent',
  });
  await app.ready();
});
afterEach(async () => {
  await app.close();
  t.close();
});

function cookiesFrom(res: { cookies: { name: string; value: string }[] }) {
  return Object.fromEntries(res.cookies.map((c) => [c.name, c.value]));
}

/** Run the full OAuth flow for a member and return their session cookie + CSRF token. */
async function login(userId: string) {
  oauth.users.set(`code-${userId}`, {
    id: userId,
    username: `u${userId.slice(-3)}`,
    global_name: null,
    avatar: null,
  });
  const start = await app.inject({ method: 'GET', url: '/api/auth/login' });
  const state = new URL(start.headers.location as string).searchParams.get('state')!;
  const stateCookie = cookiesFrom(start)[STATE_COOKIE]!;
  const cb = await app.inject({
    method: 'GET',
    url: `/api/auth/callback?code=code-${userId}&state=${state}`,
    cookies: { [STATE_COOKIE]: stateCookie },
  });
  const session = cookiesFrom(cb)[SESSION_COOKIE];
  if (!session) return { cb, cookie: null as string | null, csrf: null as string | null };
  const me = await app.inject({ method: 'GET', url: '/api/auth/me', cookies: { [SESSION_COOKIE]: session } });
  return { cb, cookie: session, csrf: me.json().csrfToken as string };
}

const grant = (roleId: string, node: string) =>
  t.services.permissions.setRule({ id: OWNER_ID, source: 'system' }, roleId, node, true);

/** A member with a Staff role that has dashboard:access (plus any extra nodes). */
function staffMember(nodes: string[] = []) {
  const staff = t.guild.addRole('Staff', 20);
  grant(staff, 'dashboard:access');
  for (const n of nodes) grant(staff, n);
  return t.guild.addMember({ roleIds: [staff], highestRolePosition: 20 });
}

describe('OAuth login', () => {
  it('redirects to Discord with a signed, httpOnly state cookie', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/auth/login' });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toMatch(/^https:\/\/discord\.com\/oauth2\/authorize/);
    const c = res.cookies.find((x) => x.name === STATE_COOKIE)!;
    expect(c).toMatchObject({ httpOnly: true, sameSite: 'Lax', secure: true, path: '/api/auth' });
  });

  it('rejects a missing or mismatched state', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/auth/callback?code=x&state=y' });
    expect(res.headers.location).toBe('/login?error=state');
  });

  it('handles a cancelled Discord consent', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/auth/callback?error=access_denied' });
    expect(res.headers.location).toBe('/login?error=cancelled');
  });

  it('refuses non-members and members without dashboard:access', async () => {
    expect((await login(sid())).cb.headers.location).toBe('/login?error=not_member');
    const plain = t.guild.addMember();
    expect((await login(plain.userId)).cb.headers.location).toBe('/login?error=forbidden');
  });

  it('creates a secure session for members with dashboard:access', async () => {
    const m = staffMember();
    const { cb, cookie } = await login(m.userId);
    expect(cb.headers.location).toBe('/');
    const c = cb.cookies.find((x) => x.name === SESSION_COOKIE)!;
    expect(c).toMatchObject({ httpOnly: true, sameSite: 'Lax', secure: true, path: '/' });
    expect(c.maxAge).toBe(168 * 3600);
    const me = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      cookies: { [SESSION_COOKIE]: cookie! },
    });
    expect(me.json()).toMatchObject({
      user: { id: m.userId },
      allowedNodes: expect.arrayContaining(['dashboard:access', 'public:help']),
    });
    expect(me.json().allowedNodes).not.toContain('admin:ban');
  });

  it('the owner always gets in', async () => {
    t.guild.addMember({ userId: OWNER_ID, highestRolePosition: 99 });
    expect((await login(OWNER_ID)).cb.headers.location).toBe('/');
  });
});

describe('session checks', () => {
  it('requires a session', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/overview' });
    expect(res.statusCode).toBe(401);
  });

  it('rejects tampered cookies', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/overview',
      cookies: { [SESSION_COOKIE]: 'forged.value' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('re-checks access on every request (role removed → 403, left server → 401)', async () => {
    const m = staffMember();
    const { cookie } = await login(m.userId);
    expect(
      (await app.inject({ method: 'GET', url: '/api/overview', cookies: { [SESSION_COOKIE]: cookie! } }))
        .statusCode,
    ).toBe(200);
    m.roleIds = [GUILD_ID];
    const denied = await app.inject({
      method: 'GET',
      url: '/api/overview',
      cookies: { [SESSION_COOKIE]: cookie! },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({ node: 'dashboard:access' });
    t.guild.members.delete(m.userId);
    expect(
      (await app.inject({ method: 'GET', url: '/api/overview', cookies: { [SESSION_COOKIE]: cookie! } }))
        .statusCode,
    ).toBe(401);
  });

  it('expires sessions', async () => {
    const m = staffMember();
    const { cookie } = await login(m.userId);
    const raw = app.parseCookie(`${SESSION_COOKIE}=${cookie}`)[SESSION_COOKIE]!;
    const unsigned = app.unsignCookie(raw).value!;
    t.services.sessions.get(unsigned); // exists
    expect(t.services.sessions.get(unsigned, Date.now() + 169 * 3_600_000)).toBeNull();
    expect(
      (await app.inject({ method: 'GET', url: '/api/overview', cookies: { [SESSION_COOKIE]: cookie! } }))
        .statusCode,
    ).toBe(401);
  });

  it('logout destroys the session', async () => {
    const m = staffMember();
    const { cookie, csrf } = await login(m.userId);
    const bad = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      cookies: { [SESSION_COOKIE]: cookie! },
    });
    expect(bad.statusCode).toBe(403);
    const out = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      cookies: { [SESSION_COOKIE]: cookie! },
      headers: { 'x-csrf-token': csrf! },
    });
    expect(out.statusCode).toBe(200);
    expect(
      (await app.inject({ method: 'GET', url: '/api/overview', cookies: { [SESSION_COOKIE]: cookie! } }))
        .statusCode,
    ).toBe(401);
  });
});

describe('CSRF and permission gates', () => {
  const warnUrl = (id: string) => `/api/members/${id}/warn`;

  it('rejects state changes without the CSRF token or from another origin', async () => {
    const m = staffMember(['admin:warn']);
    const target = t.guild.addMember();
    const { cookie, csrf } = await login(m.userId);
    const noToken = await app.inject({
      method: 'POST',
      url: warnUrl(target.userId),
      cookies: { [SESSION_COOKIE]: cookie! },
      payload: { reason: 'x' },
    });
    expect(noToken.statusCode).toBe(403);
    expect(noToken.json().error).toMatch(/CSRF/);
    const wrongOrigin = await app.inject({
      method: 'POST',
      url: warnUrl(target.userId),
      cookies: { [SESSION_COOKIE]: cookie! },
      headers: { 'x-csrf-token': csrf!, origin: 'https://evil.example' },
      payload: { reason: 'x' },
    });
    expect(wrongOrigin.statusCode).toBe(403);
    expect(wrongOrigin.json().error).toMatch(/Cross-origin/);
  });

  it('checks the same node as the slash command and records source=dashboard', async () => {
    const m = staffMember(['admin:warn']);
    const target = t.guild.addMember();
    const { cookie, csrf } = await login(m.userId);
    const headers = { 'x-csrf-token': csrf!, origin: BASE };
    const banned = await app.inject({
      method: 'POST',
      url: `/api/members/${target.userId}/ban`,
      cookies: { [SESSION_COOKIE]: cookie! },
      headers,
      payload: {},
    });
    expect(banned.statusCode).toBe(403);
    expect(banned.json()).toMatchObject({ node: 'admin:ban' });

    const warned = await app.inject({
      method: 'POST',
      url: warnUrl(target.userId),
      cookies: { [SESSION_COOKIE]: cookie! },
      headers,
      payload: { reason: 'Be nice' },
    });
    expect(warned.statusCode).toBe(200);
    expect(warned.json()).toMatchObject({ ok: true, caseNumber: 1 });
    expect(t.services.moderation.cases.get(1)).toMatchObject({ source: 'dashboard', reason: 'Be nice' });
    expect(t.services.audit.list().map((a) => a.action)).toContain('dashboard.member.warn');
  });

  it('returns service rule violations as 400s', async () => {
    const m = staffMember(['admin:timeout']);
    const target = t.guild.addMember({ isAdministrator: true });
    const { cookie, csrf } = await login(m.userId);
    const res = await app.inject({
      method: 'POST',
      url: `/api/members/${target.userId}/timeout`,
      cookies: { [SESSION_COOKIE]: cookie! },
      headers: { 'x-csrf-token': csrf! },
      payload: { duration: '10m' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/Administrator/);
    const invalid = await app.inject({
      method: 'POST',
      url: `/api/members/${target.userId}/timeout`,
      cookies: { [SESSION_COOKIE]: cookie! },
      headers: { 'x-csrf-token': csrf! },
      payload: { duration: '60d' },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error).toMatch(/Invalid input: duration/);
  });

  it('gates cases on admin:case and logs on dashboard:logs', async () => {
    const m = staffMember();
    const { cookie } = await login(m.userId);
    const get = (url: string) => app.inject({ method: 'GET', url, cookies: { [SESSION_COOKIE]: cookie! } });
    expect((await get('/api/cases')).json()).toMatchObject({ node: 'admin:case' });
    expect((await get('/api/logs')).json()).toMatchObject({ node: 'dashboard:logs' });
    const staffRole = m.roleIds.find((r) => r !== GUILD_ID)!;
    grant(staffRole, 'admin:case');
    grant(staffRole, 'dashboard:logs');
    expect((await get('/api/cases')).statusCode).toBe(200);
    expect((await get('/api/logs')).statusCode).toBe(200);
  });
});

describe('data endpoints', () => {
  async function ownerSession() {
    t.guild.addMember({ userId: OWNER_ID, highestRolePosition: 99, displayName: 'Owner' });
    const { cookie } = await login(OWNER_ID);
    return (url: string) => app.inject({ method: 'GET', url, cookies: { [SESSION_COOKIE]: cookie! } });
  }

  it('lists, searches, sorts and paginates members', async () => {
    const get = await ownerSession();
    for (const name of ['Alice', 'Bob', 'Carol']) {
      const m = t.guild.addMember({
        displayName: name,
        joinedAt: new Date(Date.now() - name.length * 86_400_000),
      });
      t.services.members.recordJoin(m, m.joinedAt!);
    }
    t.services.members.recordJoin(t.guild.members.get(OWNER_ID)!, new Date());
    const bob = [...t.guild.members.values()].find((m) => m.displayName === 'Bob')!;
    t.services.activity.recordMessage(bob.userId);

    const all = (await get('/api/members?sort=activity')).json();
    expect(all.total).toBe(4);
    expect(all.items[0].displayName).toBe('Bob');
    expect(
      (await get('/api/members?search=car')).json().items.map((i: { displayName: string }) => i.displayName),
    ).toEqual(['Carol']);
    const page = (await get('/api/members?sort=name&order=asc&page=2&pageSize=2')).json();
    expect(page.items.map((i: { displayName: string }) => i.displayName)).toEqual(['Carol', 'Owner']);
    expect((await get('/api/members?sort=bogus')).statusCode).toBe(400);
  });

  it('returns member detail with permission-aware actions', async () => {
    const get = await ownerSession();
    const m = t.guild.addMember({ displayName: 'Dana' });
    const res = (await get(`/api/members/${m.userId}`)).json();
    expect(res).toMatchObject({
      displayName: 'Dana',
      inGuild: true,
      can: { ban: true, warn: true },
      cases: [],
    });
    expect((await get('/api/members/123')).statusCode).toBe(400);
  });

  it('returns cases and logs with resolved mention names', async () => {
    const get = await ownerSession();
    const target = t.guild.addMember({ displayName: 'Eve' });
    t.services.members.recordJoin(target, new Date());
    await t.services.moderation.warn(
      { userId: OWNER_ID, displayName: 'Owner', isOwner: true, highestRolePosition: 99, source: 'slash' },
      { userId: target.userId, reason: 'spam' },
    );
    const cases = (await get('/api/cases')).json();
    expect(cases.items[0]).toMatchObject({ caseNumber: 1, label: 'Warning', targetName: 'Eve' });
    const logsRes = (await get('/api/logs?type=moderation&q=Warning')).json();
    expect(logsRes.items).toHaveLength(1);
    expect(logsRes.mentions.users[target.userId]).toBe('Eve');
    expect((await get('/api/logs?q=100%25')).json().items).toHaveLength(0);
  });

  it('serves an overview', async () => {
    const get = await ownerSession();
    const res = (await get('/api/overview')).json();
    expect(res.guild).toMatchObject({ name: 'Test Server' });
    expect(res.joinsLeaves).toHaveLength(30);
    expect(res.health).toMatchObject({ ready: true });
    expect(res.canViewCases).toBe(true);
  });

  it('sets security headers and 404s unknown API routes', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['content-security-policy']).toMatch(/frame-ancestors 'none'/);
    expect(res.headers['strict-transport-security']).toBeDefined();
  });
});

describe('static dashboard', () => {
  it('serves the app shell for client routes but 404s missing files', async () => {
    const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const dir = mkdtempSync(join(tmpdir(), 'bernard-web-'));
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>app</title>');
    mkdirSync(join(dir, 'assets'));
    writeFileSync(join(dir, 'assets', 'app-abc123.js'), 'console.log(1)');
    const web = await createApiServer({
      env,
      logger: nullLogger,
      container: t,
      startedAt: new Date(),
      oauth,
      webRoot: dir,
    });
    await web.ready();
    const page = await web.inject({ method: 'GET', url: '/members/123?tab=x' });
    expect(page.statusCode).toBe(200);
    expect(page.headers['content-type']).toMatch(/text\/html/);
    expect(page.headers['cache-control']).toBe('no-cache');
    const asset = await web.inject({ method: 'GET', url: '/assets/app-abc123.js' });
    expect(asset.headers['cache-control']).toMatch(/immutable/);
    // A file added after startup is still served.
    writeFileSync(join(dir, 'assets', 'late-def456.js'), 'console.log(2)');
    expect((await web.inject({ method: 'GET', url: '/assets/late-def456.js' })).statusCode).toBe(200);
    const missing = await web.inject({ method: 'GET', url: '/assets/gone-000000.js' });
    expect(missing.statusCode).toBe(404);
    expect(missing.headers['content-type']).toMatch(/json/);
    await web.close();
  });
});
