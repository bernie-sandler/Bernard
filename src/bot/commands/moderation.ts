import { defineCommand, defineTree } from '../../services/commands/types.js';
import { UserError } from '../../services/errors.js';
import { caseEmbed, type ModCase } from '../../services/moderation/cases.js';
import { MAX_TEMPBAN_MS, MAX_TIMEOUT_MS, modActorFrom } from '../../services/moderation/service.js';
import { formatDuration, opt } from '../../shared/commandOptions.js';
import { COLORS, ok } from '../../shared/commandResult.js';

const reasonOpt = opt.string({ description: 'Reason (shown in the mod log and DM)', maxLength: 500 });
const userOpt = (description = 'The member') => opt.user({ description, required: true as const });
const dmNote = (dmed: boolean) => (dmed ? '' : ' (could not DM them)');

const caseLine = (c: ModCase) => `Case #${c.caseNumber}`;

export const ban = defineCommand({
  name: 'ban',
  description: 'Ban a user, optionally for a limited time',
  node: 'admin:ban',
  options: {
    user: userOpt('User to ban (members or IDs)'),
    reason: reasonOpt,
    duration: opt.duration({
      description: 'Temporary ban length, e.g. 7d (omit for permanent)',
      maxMs: MAX_TEMPBAN_MS,
    }),
    delete_days: opt.integer({
      description: 'Delete their messages from the last N days (0-7)',
      min: 0,
      max: 7,
    }),
  },
  async execute(ctx, input) {
    const { case: c, dmed } = await ctx.services.moderation.ban(modActorFrom(ctx), {
      userId: input.user,
      ...(input.reason ? { reason: input.reason } : {}),
      ...(input.duration ? { durationMs: input.duration } : {}),
      ...(input.delete_days ? { deleteDays: input.delete_days } : {}),
    });
    const how = input.duration ? ` for ${formatDuration(input.duration)}` : '';
    return ok(`Banned <@${input.user}>${how}. ${caseLine(c)}${dmNote(dmed)}.`);
  },
});

export const unban = defineCommand({
  name: 'unban',
  description: 'Lift a ban',
  node: 'admin:unban',
  options: { user: userOpt('User ID to unban'), reason: reasonOpt },
  async execute(ctx, input) {
    const c = await ctx.services.moderation.unban(modActorFrom(ctx), {
      userId: input.user,
      ...(input.reason ? { reason: input.reason } : {}),
    });
    return ok(`Unbanned <@${input.user}>. ${caseLine(c)}.`);
  },
});

export const kick = defineCommand({
  name: 'kick',
  description: 'Kick a member',
  node: 'admin:kick',
  options: { user: userOpt('Member to kick'), reason: reasonOpt },
  async execute(ctx, input) {
    const { case: c, dmed } = await ctx.services.moderation.kick(modActorFrom(ctx), {
      userId: input.user,
      ...(input.reason ? { reason: input.reason } : {}),
    });
    return ok(`Kicked <@${input.user}>. ${caseLine(c)}${dmNote(dmed)}.`);
  },
});

export const timeout = defineCommand({
  name: 'timeout',
  description: 'Time out a member (max 28 days)',
  node: 'admin:timeout',
  options: {
    user: userOpt('Member to time out'),
    duration: opt.duration({
      description: 'How long, e.g. 10m, 2h, 3d',
      required: true,
      minMs: 60_000,
      maxMs: MAX_TIMEOUT_MS,
    }),
    reason: reasonOpt,
  },
  async execute(ctx, input) {
    const { case: c, dmed } = await ctx.services.moderation.timeout(modActorFrom(ctx), {
      userId: input.user,
      durationMs: input.duration,
      ...(input.reason ? { reason: input.reason } : {}),
    });
    return ok(
      `Timed out <@${input.user}> for ${formatDuration(input.duration)}. ${caseLine(c)}${dmNote(dmed)}.`,
    );
  },
});

export const untimeout = defineCommand({
  name: 'untimeout',
  description: "Remove a member's timeout",
  node: 'admin:untimeout',
  options: { user: userOpt('Member to release'), reason: reasonOpt },
  async execute(ctx, input) {
    const c = await ctx.services.moderation.untimeout(modActorFrom(ctx), {
      userId: input.user,
      ...(input.reason ? { reason: input.reason } : {}),
    });
    return ok(`Removed the timeout from <@${input.user}>. ${caseLine(c)}.`);
  },
});

export const warn = defineCommand({
  name: 'warn',
  description: 'Warn a member',
  node: 'admin:warn',
  options: {
    user: userOpt('Member to warn'),
    reason: opt.string({ description: 'Why they are being warned', required: true, maxLength: 500 }),
  },
  async execute(ctx, input) {
    const {
      case: c,
      dmed,
      activeWarnings,
    } = await ctx.services.moderation.warn(modActorFrom(ctx), {
      userId: input.user,
      reason: input.reason,
    });
    return ok(
      `Warned <@${input.user}> (${activeWarnings} active warning(s)). ${caseLine(c)}${dmNote(dmed)}.`,
    );
  },
});

export const warnings = defineTree({
  name: 'warnings',
  description: 'View or remove warnings',
  subcommands: [
    defineCommand({
      name: 'list',
      description: "List a member's active warnings",
      node: 'admin:warnings',
      options: { user: userOpt('Member to look up') },
      async execute(ctx, input) {
        const list = ctx.services.moderation.listWarnings(input.user);
        if (list.length === 0) return ok(`<@${input.user}> has no active warnings.`);
        const lines = list
          .slice(0, 20)
          .map(
            (w) =>
              `**#${w.caseNumber}** <t:${Math.floor(w.createdAt.getTime() / 1000)}:d> by <@${w.moderatorId}>: ${w.reason ?? '(no reason)'}`,
          );
        return ok('', {
          embeds: [
            {
              title: `Warnings (${list.length})`,
              description: `<@${input.user}>\n\n${lines.join('\n')}`.slice(0, 4096),
              color: COLORS.warning,
              footer: 'Remove one with /warnings remove case:<number>',
            },
          ],
        });
      },
    }),
    defineCommand({
      name: 'remove',
      description: 'Remove a warning by case number',
      node: 'admin:warnings',
      options: { case: opt.integer({ description: 'Case number of the warning', required: true, min: 1 }) },
      async execute(ctx, input) {
        const c = await ctx.services.moderation.removeWarning(modActorFrom(ctx), input.case);
        return ok(`Removed warning #${c.caseNumber} from <@${c.targetId}>.`);
      },
    }),
  ],
});

export const purge = defineCommand({
  name: 'purge',
  description: 'Bulk delete recent messages (only messages under 14 days old)',
  node: 'admin:purge',
  options: {
    amount: opt.integer({ description: 'How many messages (1-100)', required: true, min: 1, max: 100 }),
    user: opt.user({ description: 'Only delete messages from this user' }),
    channel: opt.channel({
      description: 'Channel (defaults to this one)',
      channelTypes: ['text', 'announcement', 'voice'],
      contextDefault: 'current',
    }),
  },
  async execute(ctx, input) {
    const r = await ctx.services.moderation.purge(modActorFrom(ctx), {
      channelId: input.channel,
      amount: input.amount,
      ...(input.user ? { userId: input.user } : {}),
    });
    const notes: string[] = [];
    if (r.skippedOld)
      notes.push(`${r.skippedOld} skipped because they are older than 14 days (Discord limit)`);
    if (r.skippedPinned) notes.push(`${r.skippedPinned} pinned message(s) kept`);
    if (input.user && r.deleted + r.skippedOld + r.skippedPinned < input.amount) {
      notes.push(
        `only found ${r.deleted + r.skippedOld + r.skippedPinned} from that user in the last ${r.scanned} messages`,
      );
    }
    return ok(
      `Deleted ${r.deleted} message(s) in <#${input.channel}>. ${caseLine(r.case)}.${notes.length ? `\n${notes.map((n) => `• ${n}`).join('\n')}` : ''}`,
    );
  },
});

export const slowmode = defineCommand({
  name: 'slowmode',
  description: 'Set slowmode for a channel (0 turns it off)',
  node: 'admin:slowmode',
  options: {
    seconds: opt.integer({
      description: 'Seconds between messages (0-21600)',
      required: true,
      min: 0,
      max: 21600,
    }),
    channel: opt.channel({
      description: 'Channel (defaults to this one)',
      channelTypes: ['text', 'announcement', 'voice', 'forum'],
      contextDefault: 'current',
    }),
  },
  async execute(ctx, input) {
    const c = await ctx.services.moderation.slowmode(modActorFrom(ctx), {
      channelId: input.channel,
      seconds: input.seconds,
    });
    return ok(
      input.seconds
        ? `Slowmode in <#${input.channel}> set to ${input.seconds}s. ${caseLine(c)}.`
        : `Slowmode in <#${input.channel}> turned off. ${caseLine(c)}.`,
    );
  },
});

const lockChannelOpt = opt.channel({
  description: 'Channel (defaults to this one)',
  channelTypes: ['text', 'announcement', 'voice', 'forum'],
  contextDefault: 'current',
});

export const lock = defineCommand({
  name: 'lock',
  description: 'Stop @everyone from sending messages in a channel',
  node: 'admin:lock',
  options: { channel: lockChannelOpt, reason: reasonOpt },
  async execute(ctx, input) {
    const c = await ctx.services.moderation.lock(modActorFrom(ctx), {
      channelId: input.channel,
      ...(input.reason ? { reason: input.reason } : {}),
    });
    return ok(`🔒 Locked <#${input.channel}>. ${caseLine(c)}.`);
  },
});

export const unlock = defineCommand({
  name: 'unlock',
  description: 'Restore sending in a locked channel',
  node: 'admin:unlock',
  options: { channel: lockChannelOpt, reason: reasonOpt },
  async execute(ctx, input) {
    const c = await ctx.services.moderation.unlock(modActorFrom(ctx), {
      channelId: input.channel,
      ...(input.reason ? { reason: input.reason } : {}),
    });
    return ok(`🔓 Unlocked <#${input.channel}>. ${caseLine(c)}.`);
  },
});

const roleSub = (add: boolean) =>
  defineCommand({
    name: add ? 'add' : 'remove',
    description: add ? 'Give a member a role' : 'Take a role from a member',
    node: 'admin:role',
    options: {
      user: userOpt(),
      role: opt.role({ description: 'Role', required: true }),
    },
    async execute(ctx, input) {
      const c = await ctx.services.moderation.changeRole(modActorFrom(ctx), {
        userId: input.user,
        roleId: input.role,
        add,
      });
      return ok(
        `${add ? 'Gave' : 'Removed'} <@&${input.role}> ${add ? 'to' : 'from'} <@${input.user}>. ${caseLine(c)}.`,
      );
    },
  });

export const role = defineTree({
  name: 'role',
  description: 'Add or remove a role from a member',
  subcommands: [roleSub(true), roleSub(false)],
});

export const nick = defineCommand({
  name: 'nick',
  description: "Change a member's nickname (leave empty to reset)",
  node: 'admin:nick',
  options: {
    user: userOpt(),
    nickname: opt.string({ description: 'New nickname (omit to reset)', maxLength: 32 }),
  },
  async execute(ctx, input) {
    const c = await ctx.services.moderation.setNickname(modActorFrom(ctx), {
      userId: input.user,
      ...(input.nickname ? { nickname: input.nickname } : {}),
    });
    return ok(
      input.nickname
        ? `Renamed <@${input.user}> to **${input.nickname}**. ${caseLine(c)}.`
        : `Reset <@${input.user}>'s nickname. ${caseLine(c)}.`,
    );
  },
});

export const announce = defineCommand({
  name: 'announce',
  description: 'Post an announcement as the bot',
  node: 'admin:announce',
  options: {
    channel: opt.channel({
      description: 'Where to post',
      required: true,
      channelTypes: ['text', 'announcement'],
    }),
    message: opt.string({
      description: 'Message text (use \\n for new lines)',
      required: true,
      maxLength: 4096,
      multiline: true,
    }),
    embed: opt.boolean({ description: 'Post as an embed' }),
    title: opt.string({ description: 'Optional title', maxLength: 256 }),
  },
  async execute(ctx, input) {
    const { messageId } = await ctx.services.moderation.announce(modActorFrom(ctx), {
      channelId: input.channel,
      message: input.message,
      ...(input.embed !== undefined ? { asEmbed: input.embed } : {}),
      ...(input.title ? { title: input.title } : {}),
    });
    return ok(
      `Posted in <#${input.channel}>: https://discord.com/channels/${ctx.guildId}/${input.channel}/${messageId}`,
    );
  },
});

export const caseCmd = defineCommand({
  name: 'case',
  description: 'View a moderation case',
  node: 'admin:case',
  options: { id: opt.integer({ description: 'Case number', required: true, min: 1 }) },
  async execute(ctx, input) {
    const c = ctx.services.moderation.cases.get(input.id);
    if (!c) throw new UserError(`Case #${input.id} does not exist.`);
    return ok('', { embeds: [caseEmbed(c)] });
  },
});

export const moderationCommands = [
  ban,
  unban,
  kick,
  timeout,
  untimeout,
  warn,
  warnings,
  purge,
  slowmode,
  lock,
  unlock,
  role,
  nick,
  announce,
  caseCmd,
];
