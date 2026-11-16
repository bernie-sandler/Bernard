import { defineCommand } from '../../services/commands/types.js';
import { UserError } from '../../services/errors.js';
import { opt } from '../../shared/commandOptions.js';
import { COLORS, ok, type ResultEmbedField } from '../../shared/commandResult.js';

const ts = (d: Date, style: 'R' | 'f' | 'D' = 'R') => `<t:${Math.floor(d.getTime() / 1000)}:${style}>`;

export const userinfo = defineCommand({
  name: 'userinfo',
  description: 'Show information about a member',
  node: 'public:userinfo',
  options: { user: opt.user({ description: 'Member to look up (defaults to you)' }) },
  async execute(ctx, input) {
    const { guild, permissions, moderation } = ctx.services;
    const userId = input.user ?? ctx.actor.userId;
    const member = await guild.getMember(userId);
    const user = member ? null : await guild.getUser(userId);
    if (!member && !user) throw new UserError('User not found.');
    const createdAt = member?.createdAt ?? user!.createdAt;
    const fields: ResultEmbedField[] = [
      { name: 'User', value: `<@${userId}>`, inline: true },
      { name: 'ID', value: userId, inline: true },
      { name: 'Account created', value: `${ts(createdAt, 'D')} (${ts(createdAt)})`, inline: true },
    ];
    if (member) {
      if (member.joinedAt) {
        fields.push({
          name: 'Joined server',
          value: `${ts(member.joinedAt, 'D')} (${ts(member.joinedAt)})`,
          inline: true,
        });
      }
      if (member.nickname) fields.push({ name: 'Nickname', value: member.nickname, inline: true });
      if (member.communicationDisabledUntil) {
        fields.push({
          name: 'Timed out until',
          value: ts(member.communicationDisabledUntil, 'f'),
          inline: true,
        });
      }
      const roles = member.roleIds.filter((r) => r !== ctx.guildId);
      fields.push({
        name: `Roles (${roles.length})`,
        value: roles.length
          ? roles
              .slice(0, 30)
              .map((r) => `<@&${r}>`)
              .join(' ')
          : '(none)',
      });
    } else {
      fields.push({ name: 'Membership', value: 'Not in this server', inline: true });
    }
    // Moderation details only for people allowed to see warnings.
    if (permissions.check(ctx.actor, 'admin:warnings').allowed) {
      const active = moderation.listWarnings(userId).length;
      const cases = moderation.cases.list({ targetId: userId, limit: 500 }).length;
      fields.push({
        name: 'Moderation',
        value: `${active} active warning(s), ${cases} case(s)`,
        inline: true,
      });
    }
    const displayName = member ? member.displayName : user!.username;
    const avatar = member ? member.avatarUrl : user!.avatarUrl;
    return ok('', {
      embeds: [
        {
          title: displayName,
          color: COLORS.info,
          fields,
          ...(avatar ? { thumbnailUrl: avatar } : {}),
          footer: member?.isBot || user?.isBot ? 'Bot account' : (member?.username ?? user!.username),
        },
      ],
    });
  },
});

export const serverinfo = defineCommand({
  name: 'serverinfo',
  description: 'Show information about this server',
  node: 'public:serverinfo',
  options: {},
  async execute(ctx) {
    const s = ctx.services.guild.summary();
    return ok('', {
      embeds: [
        {
          title: s.name,
          color: COLORS.info,
          ...(s.iconUrl ? { thumbnailUrl: s.iconUrl } : {}),
          fields: [
            { name: 'Owner', value: `<@${s.ownerId}>`, inline: true },
            { name: 'Created', value: `${ts(s.createdAt, 'D')} (${ts(s.createdAt)})`, inline: true },
            { name: 'Members', value: String(s.memberCount), inline: true },
            {
              name: 'Channels',
              value: `${s.channelCounts.text} text • ${s.channelCounts.voice} voice • ${s.channelCounts.category} categories`,
              inline: true,
            },
            { name: 'Roles', value: String(s.roleCount), inline: true },
            { name: 'Boosts', value: `Tier ${s.boostTier} (${s.boostCount} boosts)`, inline: true },
          ],
          footer: `Server ID: ${s.id}`,
        },
      ],
    });
  },
});

export const infoCommands = [userinfo, serverinfo];
