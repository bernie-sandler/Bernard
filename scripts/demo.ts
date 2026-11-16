/**
 * Dashboard demo: runs the real API server and built dashboard against in-memory fakes with seeded
 * data, so the UI can be explored without a Discord bot. Login skips Discord and signs you in as the
 * server owner. Never use this in production.
 *
 *   pnpm build:web && pnpm demo     → http://localhost:3100
 */
import type { OAuthClient } from '../src/api/oauth.js';
import { createApiServer } from '../src/api/server.js';
import { loadEnv } from '../src/config/env.js';
import { activityDaily } from '../src/db/schema.js';
import { createLogger } from '../src/logger.js';
import { dateKey } from '../src/services/activity.js';
import { DAY_MS } from '../src/services/members.js';
import type { ModActor } from '../src/services/moderation/service.js';
import { GUILD_ID, OWNER_ID, testContainer } from '../tests/helpers.js';

const PORT = Number(process.env.DEMO_PORT ?? 3100);
const logger = createLogger({ level: 'info', pretty: true });
const env = loadEnv({
  DISCORD_TOKEN: 'demo'.repeat(20),
  DISCORD_CLIENT_ID: '100000000000000999',
  GUILD_ID,
  DISCORD_CLIENT_SECRET: 'demo',
  SESSION_SECRET: 'demo-session-secret-demo-session-secret',
  PUBLIC_BASE_URL: `http://localhost:${PORT}`,
});

const t = testContainer();
const { guild, services, voice } = t;
const now = Date.now();
let seed = 7;
const rand = () => {
  seed = (seed * 16807) % 2147483647;
  return seed / 2147483647;
};
const pick = <T>(arr: T[]) => arr[Math.floor(rand() * arr.length)]!;
const system = { id: OWNER_ID, source: 'system' as const };

// ── Roles, channels, members ────────────────────────────────────────────────
const admin = guild.addRole('Admin', 40, { color: 0xe74c3c });
const mod = guild.addRole('Moderator', 30, { color: 0x3498db });
const veteran = guild.addRole('Veteran', 12, { color: 0xf1c40f });
const regular = guild.addRole('Regular', 11, { color: 0x2ecc71 });
const newcomer = guild.addRole('Newcomer', 10, { color: 0x95a5a6 });
guild.addRole('Booster', 5, { color: 0xff73fa, managed: true });

const general = guild.addChannel('general');
guild.addChannel('announcements', 'announcement');
const modLog = guild.addChannel('mod-log');
const category = voice.addVoiceChannel('Temp Voice', 'category');
const hub = voice.addVoiceChannel('➕ Join to create');

const NAMES = [
  'Ava',
  'Ben',
  'Cleo',
  'Dev',
  'Eli',
  'Fay',
  'Gus',
  'Hana',
  'Ivo',
  'Jade',
  'Kai',
  'Lena',
  'Milo',
  'Nia',
  'Oren',
  'Pia',
  'Quin',
  'Rae',
  'Sol',
  'Tess',
  'Uma',
  'Vik',
  'Wren',
  'Xan',
  'Yara',
  'Zed',
  'Aria',
  'Bodhi',
  'Cyra',
  'Dax',
];
guild.addMember({
  userId: OWNER_ID,
  displayName: 'Owner',
  username: 'owner',
  roleIds: [admin],
  highestRolePosition: 99,
  joinedAt: new Date(now - 900 * DAY_MS),
});
const memberIds: string[] = [];
NAMES.forEach((name, i) => {
  const days = Math.floor(rand() * 700) + 1;
  const roles = i === 0 ? [mod] : [];
  const m = guild.addMember({
    displayName: name,
    username: name.toLowerCase(),
    joinedAt: new Date(now - days * DAY_MS),
    createdAt: new Date(now - (days + Math.floor(rand() * 900)) * DAY_MS),
    roleIds: roles,
    highestRolePosition: roles.length ? 30 : 0,
  });
  memberIds.push(m.userId);
});
const bot = guild.addMember({ displayName: 'Helper Bot', username: 'helperbot', isBot: true });
services.members.syncAll([...guild.members.values()]);
void bot;

// ── Settings, permissions, tiers ────────────────────────────────────────────
services.settings.update(system, 'demo', (s) => {
  s.logs.channels.moderation = modLog;
});
services.permissions.setRule(system, mod, 'dashboard:access', true);
services.permissions.setRule(system, mod, 'admin:*', true);
services.tiers.add(system, { name: 'Newcomer', roleId: newcomer, minTenureDays: 0, minActivity: 0 });
services.tiers.add(system, { name: 'Regular', roleId: regular, minTenureDays: 30, minActivity: 60 });
services.tiers.add(system, { name: 'Veteran', roleId: veteran, minTenureDays: 365, minActivity: 0 });
services.voice.addHub(system, { channelId: hub, type: 'public', categoryId: category });

// ── Activity history (60 days) ──────────────────────────────────────────────
const rows: (typeof activityDaily.$inferInsert)[] = [];
for (const id of memberIds) {
  const level = rand();
  for (let d = 0; d < 60; d++) {
    if (rand() > level) continue;
    rows.push({
      guildId: GUILD_ID,
      userId: id,
      date: dateKey(now - d * DAY_MS),
      messagePoints: Math.floor(rand() * 12 * level),
      voiceMinutes: rand() > 0.6 ? Math.floor(rand() * 90 * level) : 0,
    });
  }
}
t.db.insert(activityDaily).values(rows).run();

// ── Logs and cases ──────────────────────────────────────────────────────────
for (let d = 0; d < 30; d++) {
  const joins = Math.floor(rand() * 4);
  const leaves = Math.floor(rand() * 2);
  for (let j = 0; j < joins + leaves; j++) {
    const id = pick(memberIds);
    services.db
      .insert((await import('../src/db/schema.js')).logs)
      .values({
        guildId: GUILD_ID,
        type: 'members',
        event: j < joins ? 'member_join' : 'member_leave',
        targetId: id,
        summary: `${guild.members.get(id)!.displayName} ${j < joins ? 'joined' : 'left'}`,
        createdAt: new Date(now - d * DAY_MS - Math.floor(rand() * DAY_MS)),
      })
      .run();
  }
}
const ownerActor: ModActor = {
  userId: OWNER_ID,
  displayName: 'Owner',
  isOwner: true,
  highestRolePosition: 99,
  source: 'slash',
};
const modActor: ModActor = {
  userId: memberIds[0]!,
  displayName: 'Ava',
  isOwner: false,
  highestRolePosition: 30,
  source: 'dashboard',
};
await services.moderation.warn(modActor, { userId: memberIds[3]!, reason: 'Please keep #general on topic' });
await services.moderation.warn(ownerActor, { userId: memberIds[3]!, reason: 'Spamming emotes' });
await services.moderation.timeout(ownerActor, {
  userId: memberIds[5]!,
  durationMs: 3_600_000,
  reason: 'Cooling off after an argument',
});
await services.moderation.recordExternal({
  action: 'ban',
  targetId: '399999999999999999',
  moderatorId: OWNER_ID,
  reason: 'Raid account',
});
await services.moderation.changeRole(ownerActor, { userId: memberIds[7]!, roleId: veteran, add: true });
await services.eventLog.messageDeleted({
  messageId: '500000000000000001',
  channelId: general,
  cached: {
    id: '500000000000000001',
    channelId: general,
    authorId: memberIds[9]!,
    authorTag: 'jade',
    content: 'oops, wrong channel',
    attachments: [],
    createdAt: now,
  },
});
await services.eventLog.voiceChanged({ userId: memberIds[2]!, tag: 'cleo', from: null, to: hub });
await services.tiers.syncAll('demo seed');

// A live temp voice channel with three people in it.
await services.voice.handleVoiceStateUpdate({
  userId: memberIds[1]!,
  displayName: 'Ben',
  username: 'ben',
  isBot: false,
  from: null,
  to: hub,
});
const temp = voice.created[0]!.id;
voice.states.set(memberIds[4]!, temp);
voice.states.set(memberIds[6]!, temp);

// ── Server ──────────────────────────────────────────────────────────────────
/** Demo login: skip Discord and sign in as the owner. */
const demoOAuth: OAuthClient = {
  authorizeUrl: (state) => `/api/auth/callback?code=demo&state=${encodeURIComponent(state)}`,
  identify: async () => ({ id: OWNER_ID, username: 'owner', global_name: 'Owner', avatar: null }),
};
const app = await createApiServer({ env, logger, container: t, startedAt: new Date(), oauth: demoOAuth });
await app.listen({ host: '127.0.0.1', port: PORT });
logger.info(`Dashboard demo running at http://localhost:${PORT} (in-memory data, demo login)`);
