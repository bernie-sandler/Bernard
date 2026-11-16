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
      pointsPerVoiceMinute: z.number().min(0).max(100).default(1),
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
      excludedRoleIds: z.array(snowflake).max(50).default([]),
      syncIntervalMinutes: z.number().int().min(5).max(1440).default(60),
    })
    .prefault({}),
});

export type Settings = z.infer<typeof settingsSchema>;

export const defaultSettings = (): Settings => settingsSchema.parse({});
