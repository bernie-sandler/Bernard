import { OAuth2Scopes, PermissionFlagsBits, PermissionsBitField } from 'discord.js';

/** Exactly the Discord permissions the bot needs, with the reason for each. */
export const REQUIRED_PERMISSIONS = [
  ['ViewChannel', PermissionFlagsBits.ViewChannel, 'See channels to log and moderate them'],
  ['SendMessages', PermissionFlagsBits.SendMessages, 'Post logs, announcements and replies'],
  ['EmbedLinks', PermissionFlagsBits.EmbedLinks, 'Log entries and replies are embeds'],
  ['ReadMessageHistory', PermissionFlagsBits.ReadMessageHistory, 'Purge needs to fetch recent messages'],
  ['ManageMessages', PermissionFlagsBits.ManageMessages, 'Purge / bulk delete'],
  ['ManageChannels', PermissionFlagsBits.ManageChannels, 'Slowmode, lock/unlock, temp voice channels'],
  [
    'ManageRoles',
    PermissionFlagsBits.ManageRoles,
    'Role add/remove, tier roles, channel permission overwrites',
  ],
  ['KickMembers', PermissionFlagsBits.KickMembers, '/kick'],
  ['BanMembers', PermissionFlagsBits.BanMembers, '/ban, /unban, temp bans'],
  ['ModerateMembers', PermissionFlagsBits.ModerateMembers, '/timeout, /untimeout'],
  ['ManageNicknames', PermissionFlagsBits.ManageNicknames, '/nick'],
  ['MoveMembers', PermissionFlagsBits.MoveMembers, 'Move members into temp voice channels, /vc kick'],
  ['Connect', PermissionFlagsBits.Connect, 'Grant Connect on private temp channels'],
  ['ViewAuditLog', PermissionFlagsBits.ViewAuditLog, 'Record bans/kicks/timeouts done outside the bot'],
] as const;

export function requiredPermissionBits(): bigint {
  return REQUIRED_PERMISSIONS.reduce((acc, [, bit]) => acc | bit, 0n);
}

export function inviteUrl(clientId: string, guildId?: string): string {
  const params = new URLSearchParams({
    client_id: clientId,
    scope: [OAuth2Scopes.Bot, OAuth2Scopes.ApplicationsCommands].join(' '),
    permissions: requiredPermissionBits().toString(),
  });
  if (guildId) {
    params.set('guild_id', guildId);
    params.set('disable_guild_select', 'true');
  }
  return `https://discord.com/oauth2/authorize?${params.toString()}`;
}

export function missingPermissions(have: bigint): string[] {
  const bits = new PermissionsBitField(have);
  if (bits.has(PermissionFlagsBits.Administrator)) return [];
  return REQUIRED_PERMISSIONS.filter(([, bit]) => !bits.has(bit)).map(([name]) => name);
}
