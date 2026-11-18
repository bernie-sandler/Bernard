import { z } from 'zod';

/**
 * Per-guild runtime settings. Stored as one JSON blob in `guild_settings` and editable from
 * slash commands and the dashboard. Every field has a default, so `{}` parses to a full config.
 */

const snowflake = z.string().regex(/^\d{17,20}$/);
const channelRef = snowflake.nullable().default(null);

export const LOG_TYPES = ['moderation', 'members', 'messages', 'voice', 'server', 'commands'] as const;
export type LogType = (typeof LOG_TYPES)[number];

export const CRAZY_ACTIONS = ['mute', 'deafen', 'disconnect', 'timeout'] as const;
export type CrazyAction = (typeof CRAZY_ACTIONS)[number];

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
      /** Points for each distinct member who reacts to your message soon after it was posted. */
      pointsPerReactionReceived: z.number().min(0).max(100).default(0.25),
      /** Only reactions added within this many minutes of the message being posted earn its author points. */
      reactionReceiveWindowMinutes: z.number().int().min(1).max(1440).default(5),
      /**
       * Receiving this many point-earning reactions within reactionGraceWindowMinutes starts a grace
       * period with no reaction points, given or received. 0 = never.
       */
      reactionGraceThreshold: z.number().int().min(0).max(1000).default(20),
      reactionGraceWindowMinutes: z.number().int().min(1).max(1440).default(60),
      reactionGraceMinutes: z.number().int().min(1).max(10080).default(360),
      /** Continuous voice minutes after which voiceLongSessionMultiplier applies. */
      voiceLongSessionMinutes: z.number().int().min(1).max(1440).default(120),
      /** Multiplier for voice minutes past voiceLongSessionMinutes; below 1 reduces them, above 1 rewards. */
      voiceLongSessionMultiplier: z.number().min(0).max(10).default(1),
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
      intervalSeconds: z.number().int().min(60).max(3600).default(60),
      /** Channel for "went down" / "back up" alerts. null = no alerts. */
      alertChannelId: channelRef,
      /** Kuma monitor ID -> role pinged by its alerts. */
      alertRoles: z
        .record(z.string().regex(/^\d{1,10}$/), snowflake)
        .refine((r) => Object.keys(r).length <= 100, 'at most 100 alert roles')
        .default({}),
    })
    .prefault({}),

  /** Issue reports sent to Belltower (/report and the report panel). URL and token come from env. */
  belltower: z
    .object({
      /** Accept new reports. Off keeps watching tickets already reported. */
      enabled: z.boolean().default(true),
      /**
       * api: Bernard files tickets through Belltower's API. link: the panel button (and /report) send
       * members to Belltower's submit page, and Bernard lists what comes in through it.
       */
      mode: z.enum(['api', 'link']).default('api'),
      /** The submit page's address (…/submit/<key>), for link mode. Checked when saved. */
      submitUrl: z.string().trim().max(500).nullable().default(null),
      /** Belltower tags put on every reported ticket. */
      labels: z.array(z.string().trim().min(1).max(50)).max(10).default(['Discord']),
      priority: z.enum(['P0', 'P1', 'P2', 'P3']).nullable().default(null),
      /** Belltower column for new tickets (name). null = Belltower's default. */
      column: z.string().trim().min(1).max(100).nullable().default(null),
      /** Minimum time between two reports from the same member. */
      cooldownSeconds: z.number().int().min(0).max(3600).default(120),
      /** Channel holding the "Report an issue" panel. null = no panel. */
      panelChannelId: channelRef,
    })
    .prefault({}),

  /** "/thatscrazy @member": a quick vote that hands out escalating voice penalties. */
  thatsCrazy: z
    .object({
      enabled: z.boolean().default(false),
      /** How long a poll stays open. */
      pollSeconds: z.number().int().min(15).max(3600).default(120),
      /** Votes needed at least, the starter's included. */
      minVotes: z.number().int().min(1).max(50).default(3),
      /**
       * Share of the other people in the target's voice channel who must vote, when that is more
       * than minVotes. 0 = always minVotes.
       */
      voiceShare: z.number().min(0).max(1).default(0.5),
      /** Passed polls older than this stop counting as strikes. */
      strikeWindowDays: z.number().int().min(1).max(365).default(30),
      /** Penalty for strike 1, 2, ...; the last step repeats. */
      ladder: z
        .array(
          z.object({
            action: z.enum(CRAZY_ACTIONS),
            minutes: z.number().int().min(1).max(40_320),
          }),
        )
        .min(1)
        .max(10)
        .default([
          { action: 'mute', minutes: 1 },
          { action: 'mute', minutes: 5 },
          { action: 'disconnect', minutes: 10 },
          { action: 'timeout', minutes: 30 },
        ]),
      /**
       * DM for strike 1, 2, ...; the last one repeats. Placeholders: {count}, {action}, {minutes},
       * {server}. An empty list sends no DM.
       */
      dmMessages: z
        .array(z.string().trim().min(1).max(1000))
        .max(10)
        .default([
          "That's crazy. The people of {server} voted, and you're {action} for {minutes} min.",
          'Strike {count}. {server} has had enough: {action} for {minutes} min.',
          'Strike {count}. At this point it is a lifestyle. {action} for {minutes} min.',
        ]),
      /** No new poll on someone this long after a poll on them passed. */
      targetCooldownMinutes: z.number().int().min(0).max(1440).default(15),
      /** No new poll on someone this long after a poll on them failed. */
      failedCooldownMinutes: z.number().int().min(0).max(1440).default(5),
      /** Minimum time between two polls started by the same member. */
      starterCooldownMinutes: z.number().int().min(0).max(1440).default(5),
      /** Members with any of these roles can't be targeted. Bots and the owner never can. */
      exemptRoleIds: z.array(snowflake).max(50).default([]),
    })
    .prefault({}),
});

export type Settings = z.infer<typeof settingsSchema>;

export const defaultSettings = (): Settings => settingsSchema.parse({});
