import { desc, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SESSION_COOKIE, STATE_COOKIE } from '../src/api/auth.js';
import type { DiscordUser, OAuthClient } from '../src/api/oauth.js';
import { type ApiServer, createApiServer } from '../src/api/server.js';
import { loadEnv } from '../src/config/env.js';
import { auditLog, logs } from '../src/db/schema.js';
import { nullLogger } from '../src/logger.js';
import { GUILD_ID, OWNER_ID, testContainer } from './helpers.js';

const BASE = 'https://bot.example.com';
const env = loadEnv({
  DISCORD_TOKEN: 'x'.repeat(70),
  DISCORD_CLIENT_ID: '123456789012345678',
  GUILD_ID,
  DISCORD_CLIENT_SECRET: 'secret',
  SESSION_SECRET: 's'.repeat(40),
  PUBLIC_BASE_URL: BASE,
});

let t: ReturnType<typeof testContainer>;
let app: ApiServer;
const users = new Map<string, DiscordUser>();
const oauth: OAuthClient = {
  authorizeUrl: (state) => `https://discord.com/oauth2/authorize?state=${state}`,
  identify: async (code) => users.get(code)!,
};

beforeEach(async () => {
  t = testContainer();
  app = await createApiServer({
    env,
    logger: nullLogger,
    container: t,
    startedAt: new Date(),
    oauth,
    webRoot: 'none',
  });
  await app.ready();
});
afterEach(async () => {
  await app.close();
  t.close();
});

// biome-ignore lint/suspicious/noExplicitAny: injected test responses are read loosely
type Json = any;

type Client = {
  get: (url: string) => Promise<{ statusCode: number; json: () => Json }>;
  send: (
    method: 'POST' | 'PATCH' | 'DELETE',
    url: string,
    payload?: unknown,
  ) => Promise<{ statusCode: number; json: () => Json }>;
};

/** Log a member in through the real OAuth flow and return a small HTTP client for them. */
async function as(userId: string): Promise<Client> {
  users.set(`c${userId}`, { id: userId, username: 'u', global_name: null, avatar: null });
  const start = await app.inject({ method: 'GET', url: '/api/auth/login' });
  const state = new URL(start.headers.location as string).searchParams.get('state')!;
  const stateCookie = start.cookies.find((c) => c.name === STATE_COOKIE)!.value;
  const cb = await app.inject({
    method: 'GET',
    url: `/api/auth/callback?code=c${userId}&state=${state}`,
    cookies: { [STATE_COOKIE]: stateCookie },
  });
  const cookie = cb.cookies.find((c) => c.name === SESSION_COOKIE)!.value;
  const me = await app.inject({ method: 'GET', url: '/api/auth/me', cookies: { [SESSION_COOKIE]: cookie } });
  const csrf = me.json().csrfToken as string;
  return {
    get: (url) => app.inject({ method: 'GET', url, cookies: { [SESSION_COOKIE]: cookie } }),
    send: (method, url, payload = {}) =>
      app.inject({
        method,
        url,
        cookies: { [SESSION_COOKIE]: cookie },
        headers: { 'x-csrf-token': csrf, origin: BASE },
        payload: payload as Record<string, unknown>,
      }),
  };
}

const owner = () => {
  t.guild.addMember({ userId: OWNER_ID, highestRolePosition: 99, displayName: 'Owner' });
  return as(OWNER_ID);
};

/** A member whose Staff role grants dashboard:access plus `nodes`. */
function staff(nodes: string[] = []) {
  const role = t.guild.addRole('Staff', 20);
  for (const n of ['dashboard:access', ...nodes]) {
    t.services.permissions.setRule({ id: OWNER_ID, source: 'system' }, role, n, true);
  }
  return t.guild.addMember({ roleIds: [role], highestRolePosition: 20 });
}

const lastAudit = () => t.db.select().from(auditLog).orderBy(desc(auditLog.id)).get()!;

describe('Command Runner', () => {
  it('lists only commands the user may run (and none marked Discord-only)', async () => {
    const c = await as(staff().userId);
    const names = (await c.get('/api/commands')).json().map((x: { fullName: string }) => x.fullName);
    expect(names).toEqual(expect.arrayContaining(['help', 'ping', 'rank', 'vc lock']));
    expect(names).not.toContain('ban');
    const purge = (await (await owner()).get('/api/commands'))
      .json()
      .find((x: { fullName: string }) => x.fullName === 'purge');
    // The channel defaults to "here" in Discord, so it is required on the dashboard and listed first.
    expect(purge.options.map((o: { name: string; required: boolean }) => [o.name, o.required])).toEqual([
      ['amount', true],
      ['channel', true],
      ['user', false],
    ]);
  });

  it('runs commands through the shared executor with source=dashboard', async () => {
    const c = await as(staff().userId);
    const res = (await c.send('POST', '/api/commands/run', { command: 'ping', input: {} })).json();
    expect(res).toMatchObject({
      outcome: 'ok',
      result: { ok: true, content: expect.stringMatching(/Pong/) },
    });
    const log = t.db.select().from(logs).where(eq(logs.type, 'commands')).orderBy(desc(logs.id)).get()!;
    expect(log.data).toMatchObject({ command: 'ping', source: 'dashboard', allowed: true });
    expect(lastAudit()).toMatchObject({ action: 'dashboard.command', target: 'ping', source: 'dashboard' });
  });

  it('validates input with the command schema and reports denials', async () => {
    const c = await owner();
    const invalid = (
      await c.send('POST', '/api/commands/run', { command: 'purge', input: { amount: 500 } })
    ).json();
    expect(invalid.outcome).toBe('invalid');
    expect(invalid.result.content).toMatch(/amount/);
    expect(invalid.result.content).toMatch(/channel/);
    const s = await as(staff().userId);
    const denied = (
      await s.send('POST', '/api/commands/run', { command: 'ban', input: { user: OWNER_ID } })
    ).json();
    expect(denied).toMatchObject({
      outcome: 'denied',
      result: { content: "You don't have permission (`admin:ban`)." },
    });
    expect((await c.send('POST', '/api/commands/run', { command: 'nope', input: {} })).statusCode).toBe(404);
  });

  it('resolves mentions in results and serves autocomplete', async () => {
    const c = await owner();
    const role = t.guild.addRole('Regular', 4);
    await c.send('POST', '/api/tiers', { name: 'Regular', roleId: role, minTenureDays: 0, minActivity: 0 });
    const ac = (await c.get('/api/commands/autocomplete?command=tiers%20edit&option=tier&q=reg')).json();
    expect(ac).toEqual([{ name: '1. Regular', value: expect.any(String) }]);
    const s = await as(staff().userId);
    expect((await s.get('/api/commands/autocomplete?command=tiers%20edit&option=tier&q=')).json()).toEqual(
      [],
    );
    for (const option of ['constructor', 'toString', 'hasOwnProperty']) {
      const inherited = await c.get(`/api/commands/autocomplete?command=tiers%20edit&option=${option}&q=`);
      expect(inherited.statusCode).toBe(200);
      expect(inherited.json()).toEqual([]);
    }
    const res = (await c.send('POST', '/api/commands/run', { command: 'tiers list', input: {} })).json();
    expect(res.mentions.roles[role]).toMatchObject({ name: 'Regular' });
  });
});

describe('Permissions editor', () => {
  it('uses the /permlist, /permset, /permunset and /permcheck nodes', async () => {
    const viewer = await as(staff(['config:permlist']).userId);
    const view = (await viewer.get('/api/permissions')).json();
    expect(view.roles[0]).toMatchObject({ id: GUILD_ID, name: '@everyone', isEveryone: true });
    expect(view.nodes.map((n: { node: string }) => n.node)).toContain('dashboard:access');
    const target = t.guild.addRole('Mod', 10);
    const denied = await viewer.send('POST', '/api/permissions', {
      roleId: target,
      node: 'admin:*',
      value: true,
    });
    expect(denied.json()).toMatchObject({ node: 'config:permset' });
    expect(
      (await viewer.send('POST', '/api/permissions/check', { userId: OWNER_ID, node: 'admin:ban' })).json(),
    ).toMatchObject({
      node: 'config:permcheck',
    });
  });

  it('sets, unsets and audits rules with before/after', async () => {
    const c = await owner();
    const mod = t.guild.addRole('Mod', 10);
    await c.send('POST', '/api/permissions', { roleId: mod, node: 'admin:*', value: true });
    await c.send('POST', '/api/permissions', { roleId: mod, node: 'admin:*', value: false });
    expect(lastAudit()).toMatchObject({
      action: 'permissions.set',
      source: 'dashboard',
      before: { allow: true },
      after: { allow: false },
    });
    expect(
      (await c.send('POST', '/api/permissions', { roleId: mod, node: 'admin:*', value: null })).json(),
    ).toEqual({
      ok: true,
      changed: true,
    });
    expect(t.services.permissions.listRules()).toHaveLength(0);
    expect(
      (await c.send('POST', '/api/permissions', { roleId: mod, node: 'admin:nope', value: true })).statusCode,
    ).toBe(400);
    expect(
      (
        await c.send('POST', '/api/permissions', {
          roleId: '999999999999999999',
          node: 'admin:*',
          value: true,
        })
      ).statusCode,
    ).toBe(400);
  });

  it('explains which rule decided', async () => {
    const c = await owner();
    const mod = t.guild.addRole('Mod', 10);
    const m = t.guild.addMember({ roleIds: [mod] });
    await c.send('POST', '/api/permissions', { roleId: mod, node: 'admin:ban', value: true });
    const res = (
      await c.send('POST', '/api/permissions/check', { userId: m.userId, node: 'admin:ban' })
    ).json();
    expect(res).toMatchObject({ allowed: true, reason: 'rule', rule: { roleId: mod } });
    expect(res.explanation).toMatch(/@Mod/);
    expect(
      (await c.send('POST', '/api/permissions/check', { userId: m.userId, node: 'admin:*' })).statusCode,
    ).toBe(400);
  });
});

describe('Tiers editor', () => {
  it('creates, edits, reorders, syncs and deletes tiers with audit rows', async () => {
    const c = await owner();
    const a = t.guild.addRole('A', 3);
    const b = t.guild.addRole('B', 4);
    const ta = (
      await c.send('POST', '/api/tiers', { name: 'A', roleId: a, minTenureDays: 0, minActivity: 0 })
    ).json();
    const tb = (
      await c.send('POST', '/api/tiers', { name: 'B', roleId: b, minTenureDays: 10, minActivity: 5 })
    ).json();
    expect(lastAudit()).toMatchObject({ action: 'tiers.add', source: 'dashboard' });
    expect((await c.send('PATCH', `/api/tiers/${tb.id}`, { minActivity: 50 })).json()).toMatchObject({
      minActivity: 50,
    });
    expect(lastAudit()).toMatchObject({
      action: 'tiers.edit',
      before: { minActivity: 5 },
      after: { minActivity: 50 },
    });
    await c.send('POST', '/api/tiers/reorder', { ids: [tb.id, ta.id] });
    const view = (await c.get('/api/tiers')).json();
    expect(view.tiers.map((x: { name: string }) => x.name)).toEqual(['B', 'A']);
    expect(view.tiers[0]).toMatchObject({ roleName: 'B', manageable: true });
    t.guild.addMember();
    const sync = (await c.send('POST', '/api/tiers/sync', { tenureOnly: true })).json();
    expect(sync).toMatchObject({ basis: 'tenure', members: 2 });
    expect((await c.get('/api/tiers')).json().lastTenureSync).toMatchObject({ basis: 'tenure' });
    await c.send('DELETE', `/api/tiers/${ta.id}`);
    expect(t.services.tiers.list()).toHaveLength(1);
  });

  it('requires config:tiers', async () => {
    const c = await as(staff().userId);
    expect((await c.get('/api/tiers')).statusCode).toBe(403);
  });
});

describe('Voice hubs', () => {
  it('manages hubs with config:voice', async () => {
    const c = await owner();
    const hub = t.voice.addVoiceChannel('Join');
    const cat = t.voice.addVoiceChannel('Temp', 'category');
    const created = await c.send('POST', '/api/voice/hubs', {
      channelId: hub,
      type: 'private',
      categoryId: cat,
      hideFromEveryone: true,
    });
    expect(created.json()).toMatchObject({ type: 'private', hideFromEveryone: true });
    expect((await c.send('PATCH', `/api/voice/hubs/${hub}`, { defaultLimit: 5 })).json()).toMatchObject({
      defaultLimit: 5,
    });
    expect((await c.get('/api/voice')).json().hubs[0]).toMatchObject({
      channelName: 'Join',
      categoryName: 'Temp',
    });
    expect(
      (await c.send('POST', '/api/voice/hubs', { channelId: hub, type: 'public', categoryId: cat }))
        .statusCode,
    ).toBe(400);
    await c.send('DELETE', `/api/voice/hubs/${hub}`);
    expect(t.services.voice.listHubs()).toHaveLength(0);
    expect(lastAudit()).toMatchObject({ action: 'voice.hub.remove', source: 'dashboard' });
  });
});

describe('Settings', () => {
  it('reports which sections the user may edit', async () => {
    const c = await as(staff(['config:voice']).userId);
    const res = (await c.get('/api/settings')).json();
    expect(res.editable).toMatchObject({ voice: true, logs: false, moderation: false });
    expect((await c.send('PATCH', '/api/settings/logs', { retentionDays: 10 })).json()).toMatchObject({
      node: 'config:logs',
    });
  });

  it('merges nested values, validates and audits before/after', async () => {
    const c = await owner();
    const ch1 = t.guild.addChannel('mod-log');
    const ch2 = t.guild.addChannel('member-log');
    await c.send('PATCH', '/api/settings/logs', { channels: { moderation: ch1 } });
    await c.send('PATCH', '/api/settings/logs', { channels: { members: ch2 }, retentionDays: 14 });
    expect(t.services.settings.get().logs).toMatchObject({
      retentionDays: 14,
      channels: { moderation: ch1, members: ch2 },
    });
    expect(lastAudit()).toMatchObject({
      action: 'settings.logs',
      source: 'dashboard',
      before: { logs: { retentionDays: 30 } },
      after: { logs: { retentionDays: 14 } },
    });
    const bad = await c.send('PATCH', '/api/settings/voice', { graceSeconds: 999 });
    expect(bad.statusCode).toBe(400);
    expect(t.services.settings.get().voice.graceSeconds).toBe(10);
    expect((await c.send('PATCH', '/api/settings/bogus', {})).statusCode).toBe(400);
  });

  it('rejects keys the section does not have', async () => {
    const c = await owner();
    const before = t.services.settings.get().logs;
    for (const body of [
      { nope: 1 },
      { constructor: { polluted: true } },
      { retentionDays: 14, extra: 'x' },
    ]) {
      const res = await c.send('PATCH', '/api/settings/logs', body);
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/Unknown logs setting/);
    }
    expect(t.services.settings.get().logs).toEqual(before);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('refuses log channels the bot cannot post in', async () => {
    const c = await owner();
    t.messenger.fail = true;
    const res = await c.send('PATCH', '/api/settings/logs', {
      channels: { voice: t.guild.addChannel('nope') },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/can't post in #nope/);
    expect(t.services.settings.get().logs.channels.voice).toBeNull();
  });

  it('gates settings without a slash command on config:settings', async () => {
    const c = await as(staff(['config:logs']).userId);
    expect((await c.send('PATCH', '/api/settings/moderation', { dmOnAction: false })).json()).toMatchObject({
      node: 'config:settings',
    });
    const o = await owner();
    await o.send('PATCH', '/api/settings/moderation', { dmOnAction: false });
    expect(t.services.settings.get().moderation.dmOnAction).toBe(false);
  });
});

describe('Audit log', () => {
  it('requires dashboard:audit and labels targets', async () => {
    const s = await as(staff().userId);
    expect((await s.get('/api/audit')).json()).toMatchObject({ node: 'dashboard:audit' });
    const c = await owner();
    const mod = t.guild.addRole('Mod', 10);
    await c.send('POST', '/api/permissions', { roleId: mod, node: 'admin:*', value: true });
    const res = (await c.get('/api/audit?action=permissions.&source=dashboard')).json();
    expect(res.items).toHaveLength(1);
    expect(res.items[0]).toMatchObject({
      action: 'permissions.set',
      targetLabel: '@Mod admin:*',
      actor: { name: 'Owner' },
    });
    const all = (await c.get('/api/audit?limit=1')).json();
    expect(all.items).toHaveLength(1);
    expect(all.nextBefore).not.toBeNull();
  });
});
