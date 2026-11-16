import { SESSION_COOKIE, STATE_COOKIE } from '../src/api/auth.js';
import type { DiscordUser, OAuthClient } from '../src/api/oauth.js';
import { type ApiServer, createApiServer } from '../src/api/server.js';
import { loadEnv } from '../src/config/env.js';
import { nullLogger } from '../src/logger.js';
import { GUILD_ID, OWNER_ID, testContainer } from './helpers.js';

export const BASE = 'https://bot.example.com';

// biome-ignore lint/suspicious/noExplicitAny: injected test responses are read loosely
type Json = any;
export interface Client {
  get: (url: string) => Promise<{ statusCode: number; json: () => Json }>;
  send: (
    method: 'POST' | 'PATCH' | 'DELETE',
    url: string,
    payload?: unknown,
  ) => Promise<{ statusCode: number; json: () => Json }>;
}

/** A test container plus the real API server, with OAuth faked and a helper to log members in. */
export async function apiHarness() {
  const t = testContainer();
  const users = new Map<string, DiscordUser>();
  const oauth: OAuthClient = {
    authorizeUrl: (state) => `https://discord.com/oauth2/authorize?state=${state}`,
    identify: async (code) => users.get(code)!,
  };
  const env = loadEnv({
    DISCORD_TOKEN: 'x'.repeat(70),
    DISCORD_CLIENT_ID: '123456789012345678',
    GUILD_ID,
    DISCORD_CLIENT_SECRET: 'secret',
    SESSION_SECRET: 's'.repeat(40),
    PUBLIC_BASE_URL: BASE,
  });
  const app: ApiServer = await createApiServer({
    env,
    logger: nullLogger,
    container: t,
    startedAt: new Date(),
    oauth,
    webRoot: 'none',
  });
  await app.ready();

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
    const me = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      cookies: { [SESSION_COOKIE]: cookie },
    });
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
    if (!t.guild.members.has(OWNER_ID)) {
      t.guild.addMember({ userId: OWNER_ID, highestRolePosition: 99, displayName: 'Owner' });
    }
    return as(OWNER_ID);
  };

  const close = async () => {
    await app.close();
    t.close();
  };

  return { t, app, as, owner, close };
}
