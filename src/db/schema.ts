import { sql } from 'drizzle-orm';
import { index, integer, primaryKey, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

/**
 * All tables carry guild_id even though one guild is supported, so multi-guild stays possible.
 * Timestamps are integer milliseconds since epoch (Drizzle maps them to Date).
 */

const createdAt = () =>
  integer('created_at', { mode: 'timestamp_ms' }).notNull().default(sql`(unixepoch('subsec') * 1000)`);

// ── Settings & state ────────────────────────────────────────────────────────

export const guildSettings = sqliteTable('guild_settings', {
  guildId: text('guild_id').primaryKey(),
  data: text('data', { mode: 'json' }).notNull().$type<unknown>(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
});

export const botState = sqliteTable(
  'bot_state',
  {
    guildId: text('guild_id').notNull(),
    key: text('key').notNull(),
    value: text('value').notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.guildId, t.key] })],
);

// ── Permissions ─────────────────────────────────────────────────────────────

export const permissionRules = sqliteTable(
  'permission_rules',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    guildId: text('guild_id').notNull(),
    roleId: text('role_id').notNull(),
    node: text('node').notNull(),
    allow: integer('allow', { mode: 'boolean' }).notNull(),
    createdBy: text('created_by').notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('permission_rules_guild_role_node').on(t.guildId, t.roleId, t.node)],
);

// ── Moderation ──────────────────────────────────────────────────────────────

export const MOD_ACTIONS = [
  'ban',
  'unban',
  'kick',
  'timeout',
  'untimeout',
  'warn',
  'purge',
  'role_add',
  'role_remove',
  'nick',
  'slowmode',
  'lock',
  'unlock',
] as const;
export type ModAction = (typeof MOD_ACTIONS)[number];
export const MOD_SOURCES = ['slash', 'dashboard', 'discord', 'system'] as const;
export type ModSource = (typeof MOD_SOURCES)[number];

export const modCases = sqliteTable(
  'mod_cases',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    guildId: text('guild_id').notNull(),
    caseNumber: integer('case_number').notNull(),
    action: text('action', { enum: MOD_ACTIONS }).notNull(),
    targetId: text('target_id').notNull(),
    moderatorId: text('moderator_id').notNull(),
    reason: text('reason'),
    durationMs: integer('duration_ms'),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }),
    source: text('source', { enum: MOD_SOURCES }).notNull(),
    /** Warnings can be removed (active=false) without deleting history. */
    active: integer('active', { mode: 'boolean' }).notNull().default(true),
    data: text('data', { mode: 'json' }).$type<Record<string, unknown>>(),
    logMessageId: text('log_message_id'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('mod_cases_guild_number').on(t.guildId, t.caseNumber),
    index('mod_cases_guild_target').on(t.guildId, t.targetId),
    index('mod_cases_guild_created').on(t.guildId, t.createdAt),
  ],
);

export const scheduledActions = sqliteTable(
  'scheduled_actions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    guildId: text('guild_id').notNull(),
    kind: text('kind', { enum: ['unban'] }).notNull(),
    targetId: text('target_id').notNull(),
    caseId: integer('case_id').references(() => modCases.id),
    runAt: integer('run_at', { mode: 'timestamp_ms' }).notNull(),
    doneAt: integer('done_at', { mode: 'timestamp_ms' }),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    createdAt: createdAt(),
  },
  (t) => [index('scheduled_actions_due').on(t.doneAt, t.runAt)],
);

// ── Logs ────────────────────────────────────────────────────────────────────

export const logs = sqliteTable(
  'logs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    guildId: text('guild_id').notNull(),
    type: text('type', {
      enum: ['moderation', 'members', 'messages', 'voice', 'server', 'commands'],
    }).notNull(),
    event: text('event').notNull(),
    actorId: text('actor_id'),
    targetId: text('target_id'),
    channelId: text('channel_id'),
    summary: text('summary').notNull(),
    data: text('data', { mode: 'json' }).$type<Record<string, unknown>>(),
    createdAt: createdAt(),
  },
  (t) => [
    index('logs_guild_type_created').on(t.guildId, t.type, t.createdAt),
    index('logs_guild_actor').on(t.guildId, t.actorId),
    index('logs_guild_target').on(t.guildId, t.targetId),
    index('logs_created').on(t.createdAt),
  ],
);

export const auditLog = sqliteTable(
  'audit_log',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    guildId: text('guild_id').notNull(),
    actorId: text('actor_id').notNull(),
    source: text('source', { enum: ['slash', 'dashboard', 'system'] }).notNull(),
    action: text('action').notNull(),
    target: text('target'),
    before: text('before', { mode: 'json' }),
    after: text('after', { mode: 'json' }),
    createdAt: createdAt(),
  },
  (t) => [index('audit_log_guild_created').on(t.guildId, t.createdAt)],
);

// ── Members, tenure & activity ──────────────────────────────────────────────

export const members = sqliteTable(
  'members',
  {
    guildId: text('guild_id').notNull(),
    userId: text('user_id').notNull(),
    username: text('username').notNull(),
    displayName: text('display_name').notNull(),
    avatar: text('avatar'),
    isBot: integer('is_bot', { mode: 'boolean' }).notNull().default(false),
    /** Earliest join the bot has seen (backfill uses Discord's joinedAt, which is the latest join). */
    firstJoinedAt: integer('first_joined_at', { mode: 'timestamp_ms' }).notNull(),
    /** Join date used for tenure (reset on rejoin when configured). */
    joinedAt: integer('joined_at', { mode: 'timestamp_ms' }).notNull(),
    leftAt: integer('left_at', { mode: 'timestamp_ms' }),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.guildId, t.userId] }),
    index('members_guild_display').on(t.guildId, t.displayName),
  ],
);

export const activityDaily = sqliteTable(
  'activity_daily',
  {
    guildId: text('guild_id').notNull(),
    userId: text('user_id').notNull(),
    /** UTC date, YYYY-MM-DD. */
    date: text('date').notNull(),
    messagePoints: real('message_points').notNull().default(0),
    voiceMinutes: integer('voice_minutes').notNull().default(0),
    /** Messages with an image attachment that earned the image bonus. */
    imageCount: integer('image_count').notNull().default(0),
    /** Messages with a link that earned the link bonus. */
    linkCount: integer('link_count').notNull().default(0),
    /** Reactions added that earned a point. */
    reactionCount: integer('reaction_count').notNull().default(0),
    /** Voice minutes past the long-session threshold (also counted in voiceMinutes). */
    voiceLongMinutes: integer('voice_long_minutes').notNull().default(0),
    /** Reactions from others on this member's messages that earned points. */
    reactionsReceivedCount: integer('reactions_received_count').notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.guildId, t.userId, t.date] }),
    index('activity_daily_guild_date').on(t.guildId, t.date),
  ],
);

export const tiers = sqliteTable(
  'tiers',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    guildId: text('guild_id').notNull(),
    name: text('name').notNull(),
    roleId: text('role_id').notNull(),
    minTenureDays: integer('min_tenure_days').notNull().default(0),
    minActivity: real('min_activity').notNull().default(0),
    position: integer('position').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('tiers_guild_role').on(t.guildId, t.roleId),
    index('tiers_guild_position').on(t.guildId, t.position),
  ],
);

export const memberTierState = sqliteTable(
  'member_tier_state',
  {
    guildId: text('guild_id').notNull(),
    userId: text('user_id').notNull(),
    tierId: integer('tier_id')
      .notNull()
      .references(() => tiers.id, { onDelete: 'cascade' }),
    /** When the member first dropped below this tier's thresholds (demotion grace). */
    belowSince: integer('below_since', { mode: 'timestamp_ms' }),
  },
  (t) => [primaryKey({ columns: [t.guildId, t.userId, t.tierId] })],
);

// ── Voice ───────────────────────────────────────────────────────────────────

export const voiceHubs = sqliteTable('voice_hubs', {
  channelId: text('channel_id').primaryKey(),
  guildId: text('guild_id').notNull(),
  type: text('type', { enum: ['public', 'private'] }).notNull(),
  categoryId: text('category_id').notNull(),
  nameTemplate: text('name_template').notNull().default("{user}'s Channel"),
  defaultLimit: integer('default_limit').notNull().default(0),
  /** Private hubs only: also hide the channel from @everyone (default: visible but locked). */
  hideFromEveryone: integer('hide_from_everyone', { mode: 'boolean' }).notNull().default(false),
  createdAt: createdAt(),
});

export const tempChannels = sqliteTable(
  'temp_channels',
  {
    channelId: text('channel_id').primaryKey(),
    guildId: text('guild_id').notNull(),
    hubChannelId: text('hub_channel_id').notNull(),
    ownerId: text('owner_id'),
    /** Ordered list of {userId, joinedAt} for ownership transfer. */
    occupants: text('occupants', { mode: 'json' })
      .notNull()
      .$type<{ userId: string; joinedAt: number }[]>()
      .default(sql`'[]'`),
    renameTimestamps: text('rename_timestamps', { mode: 'json' })
      .notNull()
      .$type<number[]>()
      .default(sql`'[]'`),
    createdAt: createdAt(),
  },
  (t) => [index('temp_channels_guild').on(t.guildId)],
);

// ── Self-assign role panels ─────────────────────────────────────────────────

export interface RolePanelOption {
  roleId: string;
  label: string;
  emoji: string | null;
  description: string | null;
}

export const rolePanels = sqliteTable(
  'role_panels',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    guildId: text('guild_id').notNull(),
    title: text('title').notNull(),
    description: text('description').notNull().default(''),
    /** buttons: one toggle button per role. select: a dropdown menu. */
    style: text('style', { enum: ['buttons', 'select'] })
      .notNull()
      .default('buttons'),
    /** multi: any number of roles. single: picking one removes the panel's other roles. */
    mode: text('mode', { enum: ['multi', 'single'] })
      .notNull()
      .default('multi'),
    /** Roles offered, in display order. */
    options: text('options', { mode: 'json' }).notNull().$type<RolePanelOption[]>().default(sql`'[]'`),
    /** Where the panel is posted; null until posted. */
    channelId: text('channel_id'),
    messageId: text('message_id'),
    createdAt: createdAt(),
  },
  (t) => [index('role_panels_guild').on(t.guildId)],
);

// ── Dashboard sessions ──────────────────────────────────────────────────────

export const sessions = sqliteTable(
  'sessions',
  {
    /** sha256 of the session id; the raw id lives only in the cookie. */
    idHash: text('id_hash').primaryKey(),
    guildId: text('guild_id').notNull(),
    userId: text('user_id').notNull(),
    csrfToken: text('csrf_token').notNull(),
    user: text('user', { mode: 'json' }).notNull().$type<{ username: string; avatar: string | null }>(),
    createdAt: createdAt(),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [index('sessions_expires').on(t.expiresAt)],
);
