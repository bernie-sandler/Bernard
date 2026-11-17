import { z } from 'zod';

/**
 * Per-guild runtime settings. Stored as one JSON blob in `guild_settings` and editable from
 * slash commands and the dashboard. Every field has a default, so `{}` parses to a full config.
 */

const snowflake = z.string().regex(/^\d{17,20}$/);
const channelRef = snowflake.nullable().default(null);

export const LOG_TYPES = ['moderation', 'members', 'messages', 'voice', 'server', 'commands'] as const;
export type LogType = (typeof LOG_TYPES)[number];

export const settingsSchema = z.object({
  permissions: z
    .object({
      /** Members with Discord's Administrator permission bypass the custom permission system. */
      adminBypass: z.boolean().default(true),
    })
    .prefault({}),

  logs: z
    .object({
      channels: z
        .object({
          moderation: channelRef,
          members: channelRef,
          messages: channelRef,
          voice: channelRef,
          server: channelRef,
          commands: channelRef,
        })
        .prefault({}),
      retentionDays: z.number().int().min(1).max(365).default(30),
      newAccountDays: z.number().int().min(0).max(365).default(7),
      messageCacheSize: z.number().int().min(100).max(100_000).default(5000),
    })
    .prefault({}),

  moderation: z
    .object({
      /** DM members when they are warned, timed out, kicked or banned (best-effort). */
      dmOnAction: z.boolean().default(true),
    })
    .prefault({}),

  voice: z
    .object({
      graceSeconds: z.number().int().min(0).max(300).default(10),
      hubCooldownSeconds: z.number().int().min(0).max(3600).default(30),
      ownerLeaveMode: z.enum(['transfer', 'claim']).default('transfer'),
    })
    .prefault({}),

  activity: z
    .object({
      messageCooldownSeconds: z.number().int().min(0).max(3600).default(60),
      pointsPerMessage: z.number().min(0).max(100).default(1),
      pointsPerVoiceMinute: z.number().min(0).max(100).default(0.2),
      /** Bonus on top of the message point for a message with an image attachment. */
      pointsPerImage: z.number().min(0).max(100).default(1),
      /** Bonus on top of the message point for a message with a link. */
      pointsPerLink: z.number().min(0).max(100).default(0.5),
      /** Points for adding a reaction to someone else's message. */
      pointsPerReaction: z.number().min(0).max(100).default(0.25),
      countSelfDeafened: z.boolean().default(false),
      windowDays: z.number().int().min(1).max(365).default(30),
    })
    .prefault({}),

  tenure: z
    .object({
      resetOnRejoin: z.boolean().default(true),
    })
    .prefault({}),

  tiers: z
    .object({
      mode: z.enum(['highest_only', 'stack']).default('highest_only'),
      demotion: z.boolean().default(true),
      demotionGraceDays: z.number().int().min(0).max(90).default(7),
      /**
       * Demotion never takes a member below this tier while they meet its tenure requirement
       * (they're also placed in it without activity). null = no floor.
       */
      demotionFloorTierId: z.number().int().positive().nullable().default(null),
      excludedRoleIds: z.array(snowflake).max(50).default([]),
      syncIntervalMinutes: z.number().int().min(5).max(1440).default(60),
    })
    .prefault({}),

  /** Live status embed fed by an Uptime Kuma status page. */
  status: z
    .object({
      /** Base URL of Uptime Kuma, e.g. http://tower:3001. null = not configured. */
      kumaUrl: z
        .url({ protocol: /^https?$/, error: 'must be an http(s) URL' })
        .max(500)
        .nullable()
        .default(null),
      /** Slug of the Kuma status page to read (the part after /status/). */
      slug: z
        .string()
        .regex(/^[a-zA-Z0-9_-]{1,100}$/, 'must be a status page slug')
        .nullable()
        .default(null),
      /** Channel holding the pinned status embed. null = no embed. */
      channelId: channelRef,
      intervalSeconds: z.number().int().min(30).max(3600).default(60),
      /** Channel for "went down" / "back up" alerts. null = no alerts. */
      alertChannelId: channelRef,
      /** Kuma monitor ID -> role pinged by its alerts. */
      alertRoles: z
        .record(z.string().regex(/^\d{1,10}$/), snowflake)
        .refine((r) => Object.keys(r).length <= 100, 'at most 100 alert roles')
        .default({}),
    })
    .prefault({}),
});

export type Settings = z.infer<typeof settingsSchema>;

export const defaultSettings = (): Settings => settingsSchema.parse({});
