import { describe, expect, it } from 'vitest';
import { ConfigError, loadEnv } from '../src/config/env.js';
import { defaultSettings, settingsSchema } from '../src/config/settings.js';
import { nullLogger } from '../src/logger.js';
import { AuditService } from '../src/services/audit.js';
import { UserError } from '../src/services/errors.js';
import { SettingsService } from '../src/services/settings.js';
import { GUILD_ID, memoryDb } from './helpers.js';

const valid = {
  DISCORD_TOKEN: 'x'.repeat(70),
  DISCORD_CLIENT_ID: '123456789012345678',
  GUILD_ID: '123456789012345679',
  DISCORD_CLIENT_SECRET: 'secret',
  SESSION_SECRET: 'y'.repeat(32),
};

describe('loadEnv', () => {
  it('applies defaults', () => {
    const env = loadEnv(valid);
    expect(env).toMatchObject({
      PORT: 3000,
      DATABASE_PATH: '/data/bernard.db',
      TRUST_PROXY: false,
      COOKIE_SECURE: false,
      DASHBOARD_ENABLED: true,
    });
  });

  it('derives secure cookies from an https base URL and strips trailing slashes', () => {
    const env = loadEnv({ ...valid, PUBLIC_BASE_URL: 'https://bot.example.com/' });
    expect(env.PUBLIC_BASE_URL).toBe('https://bot.example.com');
    expect(env.COOKIE_SECURE).toBe(true);
  });

  it.each([
    ['true', true],
    ['1', 1],
    ['10.0.0.1, 172.16.0.0/12', ['10.0.0.1', '172.16.0.0/12']],
  ])('parses TRUST_PROXY=%j', (value, expected) => {
    expect(loadEnv({ ...valid, TRUST_PROXY: value }).TRUST_PROXY).toEqual(expected);
  });

  it('fails fast listing every problem', () => {
    try {
      loadEnv({ DISCORD_TOKEN: 'short', GUILD_ID: 'abc' });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      const msg = (err as Error).message;
      expect(msg).toMatch(/DISCORD_TOKEN/);
      expect(msg).toMatch(/DISCORD_CLIENT_ID/);
      expect(msg).toMatch(/GUILD_ID/);
      expect(msg).toMatch(/SESSION_SECRET/);
    }
  });

  it('does not require dashboard secrets when the dashboard is disabled', () => {
    const { DISCORD_CLIENT_SECRET: _a, SESSION_SECRET: _b, ...rest } = valid;
    expect(() => loadEnv({ ...rest, DASHBOARD_ENABLED: 'false' })).not.toThrow();
    expect(() => loadEnv(rest)).toThrow(ConfigError);
  });
});

describe('settings', () => {
  it('parses {} into full defaults', () => {
    const s = defaultSettings();
    expect(s.permissions.adminBypass).toBe(true);
    expect(s.logs.retentionDays).toBe(30);
    expect(s.logs.channels.commands).toBeNull();
    expect(s.tiers.mode).toBe('highest_only');
    expect(s.activity.windowDays).toBe(30);
    expect(settingsSchema.parse({ logs: { retentionDays: 7 } }).logs.messageCacheSize).toBe(5000);
  });

  it('persists, validates and audits changes', () => {
    const { db, close } = memoryDb();
    const audit = new AuditService(db, GUILD_ID);
    const svc = new SettingsService(db, GUILD_ID, audit, nullLogger);
    const actor = { id: '1', source: 'slash' as const };
    svc.update(actor, 'settings.logs', (s) => {
      s.logs.retentionDays = 14;
    });
    expect(new SettingsService(db, GUILD_ID, audit, nullLogger).get().logs.retentionDays).toBe(14);
    expect(() =>
      svc.update(actor, 'settings.logs', (s) => {
        s.logs.retentionDays = 0;
      }),
    ).toThrow(UserError);
    const rows = audit.list();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: 'settings.logs', before: { logs: { retentionDays: 30 } } });
    close();
  });
});
