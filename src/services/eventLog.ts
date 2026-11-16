import type { LogType } from '../config/settings.js';
import { COLORS, type ResultEmbed } from '../shared/commandResult.js';
import type { LogService } from './logs.js';
import type { CachedMessage } from './messageCache.js';
import type { SettingsService } from './settings.js';

/**
 * Turns Discord events (already converted to plain data by src/bot/events) into log entries for the
 * members, messages, voice and server log types.
 */

export interface RoleSnapshot {
  id: string;
  name: string;
  color: number;
  hoist: boolean;
  mentionable: boolean;
  permissions: string[];
}

export interface ChannelSnapshot {
  id: string;
  name: string;
  kind: string;
  topic: string | null;
  nsfw: boolean;
  rateLimitPerUser: number;
  parentId: string | null;
  userLimit: number;
  /** Stable serialization of permission overwrites, to detect changes. */
  overwrites: string;
}

const ts = (d: Date | number, style: 'R' | 'f' = 'R') =>
  `<t:${Math.floor((typeof d === 'number' ? d : d.getTime()) / 1000)}:${style}>`;
const clip = (s: string, n = 1024) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const hex = (c: number) => `#${c.toString(16).padStart(6, '0')}`;

export function diffRole(a: RoleSnapshot, b: RoleSnapshot): string[] {
  const out: string[] = [];
  if (a.name !== b.name) out.push(`Name: ${a.name} → ${b.name}`);
  if (a.color !== b.color) out.push(`Color: ${hex(a.color)} → ${hex(b.color)}`);
  if (a.hoist !== b.hoist) out.push(`Displayed separately: ${a.hoist} → ${b.hoist}`);
  if (a.mentionable !== b.mentionable) out.push(`Mentionable: ${a.mentionable} → ${b.mentionable}`);
  const added = b.permissions.filter((p) => !a.permissions.includes(p));
  const removed = a.permissions.filter((p) => !b.permissions.includes(p));
  if (added.length) out.push(`Permissions granted: ${added.join(', ')}`);
  if (removed.length) out.push(`Permissions revoked: ${removed.join(', ')}`);
  return out;
}

export function diffChannel(a: ChannelSnapshot, b: ChannelSnapshot): string[] {
  const out: string[] = [];
  if (a.name !== b.name) out.push(`Name: ${a.name} → ${b.name}`);
  if ((a.topic ?? '') !== (b.topic ?? '')) out.push(`Topic: ${a.topic || '(none)'} → ${b.topic || '(none)'}`);
  if (a.nsfw !== b.nsfw) out.push(`NSFW: ${a.nsfw} → ${b.nsfw}`);
  if (a.rateLimitPerUser !== b.rateLimitPerUser) {
    out.push(`Slowmode: ${a.rateLimitPerUser}s → ${b.rateLimitPerUser}s`);
  }
  if (a.parentId !== b.parentId) {
    out.push(
      `Category: ${a.parentId ? `<#${a.parentId}>` : '(none)'} → ${b.parentId ? `<#${b.parentId}>` : '(none)'}`,
    );
  }
  if (a.userLimit !== b.userLimit) out.push(`User limit: ${a.userLimit || '∞'} → ${b.userLimit || '∞'}`);
  if (a.overwrites !== b.overwrites) out.push('Permission overwrites changed');
  return out;
}

export class EventLogService {
  constructor(
    private readonly logs: LogService,
    private readonly settings: SettingsService,
  ) {}

  /** Message events in log channels themselves are ignored to avoid feedback noise. */
  isLogChannel(channelId: string | null): boolean {
    if (!channelId) return false;
    return Object.values(this.settings.get().logs.channels).includes(channelId);
  }

  private async emit(
    type: LogType,
    event: string,
    summary: string,
    embed: ResultEmbed,
    extra: {
      actorId?: string | null;
      targetId?: string | null;
      channelId?: string | null;
      data?: Record<string, unknown>;
    } = {},
  ): Promise<void> {
    // Always stored in the DB (the dashboard shows them); posted only if a channel is routed.
    await this.logs.record({ type, event, summary, embed, ...extra });
  }

  // ── Members ──────────────────────────────────────────────────────────────

  async memberJoined(m: {
    userId: string;
    tag: string;
    avatarUrl: string | null;
    accountCreatedAt: Date;
    memberCount: number;
    isBot: boolean;
  }): Promise<void> {
    const ageDays = Math.floor((Date.now() - m.accountCreatedAt.getTime()) / 86_400_000);
    const threshold = this.settings.get().logs.newAccountDays;
    const isNew = threshold > 0 && ageDays < threshold;
    const fields: NonNullable<ResultEmbed['fields']> = [
      { name: 'Member', value: `<@${m.userId}> (${m.tag})`, inline: true },
      {
        name: 'Account created',
        value: `${ts(m.accountCreatedAt, 'f')} (${ts(m.accountCreatedAt)})`,
        inline: true,
      },
      { name: 'Member count', value: String(m.memberCount), inline: true },
    ];
    if (isNew)
      fields.push({ name: '⚠️ New account', value: `Created ${ageDays} day(s) ago (under ${threshold})` });
    if (m.isBot) fields.push({ name: 'Bot', value: 'This account is a bot' });
    await this.emit(
      'members',
      'member_join',
      `${m.tag} joined${isNew ? ` (new account, ${ageDays}d old)` : ''}`,
      {
        title: isNew ? 'Member joined ⚠️' : 'Member joined',
        color: isNew ? COLORS.warning : COLORS.success,
        fields,
        ...(m.avatarUrl ? { thumbnailUrl: m.avatarUrl } : {}),
        footer: `User ID: ${m.userId}`,
      },
      { targetId: m.userId, data: { tag: m.tag, accountAgeDays: ageDays, newAccount: isNew } },
    );
  }

  async memberLeft(m: {
    userId: string;
    tag: string;
    joinedAt: Date | null;
    roleIds: string[];
  }): Promise<void> {
    const roles = m.roleIds.map((r) => `<@&${r}>`).join(' ') || '(none)';
    await this.emit(
      'members',
      'member_leave',
      `${m.tag} left`,
      {
        title: 'Member left',
        color: COLORS.danger,
        fields: [
          { name: 'Member', value: `<@${m.userId}> (${m.tag})`, inline: true },
          { name: 'Joined', value: m.joinedAt ? ts(m.joinedAt) : 'unknown', inline: true },
          { name: 'Roles', value: clip(roles) },
        ],
        footer: `User ID: ${m.userId}`,
      },
      { targetId: m.userId, data: { tag: m.tag, roleIds: m.roleIds } },
    );
  }

  async nicknameChanged(m: {
    userId: string;
    tag: string;
    before: string | null;
    after: string | null;
  }): Promise<void> {
    await this.emit(
      'members',
      'nickname_change',
      `${m.tag} nickname: ${m.before ?? '(none)'} → ${m.after ?? '(none)'}`,
      {
        title: 'Nickname changed',
        color: COLORS.info,
        fields: [
          { name: 'Member', value: `<@${m.userId}>`, inline: true },
          { name: 'Before', value: m.before ?? '(none)', inline: true },
          { name: 'After', value: m.after ?? '(none)', inline: true },
        ],
        footer: `User ID: ${m.userId}`,
      },
      { targetId: m.userId, data: { before: m.before, after: m.after } },
    );
  }

  async tierChanged(m: {
    userId: string;
    added: string[];
    removed: string[];
    reason: string;
  }): Promise<void> {
    await this.emit(
      'members',
      'tier_change',
      `<@${m.userId}> tier change: +${m.added.length} −${m.removed.length} (${m.reason})`,
      {
        title: 'Tier updated',
        color: COLORS.info,
        fields: [
          { name: 'Member', value: `<@${m.userId}>`, inline: true },
          ...(m.added.length
            ? [{ name: 'Added', value: m.added.map((r) => `<@&${r}>`).join(' '), inline: true }]
            : []),
          ...(m.removed.length
            ? [{ name: 'Removed', value: m.removed.map((r) => `<@&${r}>`).join(' '), inline: true }]
            : []),
          { name: 'Reason', value: m.reason },
        ],
        footer: `User ID: ${m.userId}`,
      },
      { targetId: m.userId, data: m },
    );
  }

  // ── Messages ─────────────────────────────────────────────────────────────

  async messageEdited(m: {
    messageId: string;
    channelId: string;
    authorId: string;
    authorTag: string;
    before: string | null;
    after: string;
    url: string;
  }): Promise<void> {
    if (m.before !== null && m.before === m.after) return; // embed-only update
    await this.emit(
      'messages',
      'message_edit',
      `${m.authorTag} edited a message in <#${m.channelId}>`,
      {
        title: 'Message edited',
        color: COLORS.warning,
        description: `[Jump to message](${m.url}) in <#${m.channelId}> by <@${m.authorId}>`,
        fields: [
          { name: 'Before', value: m.before === null ? '*(not cached)*' : clip(m.before || '*(empty)*') },
          { name: 'After', value: clip(m.after || '*(empty)*') },
        ],
        footer: `Author ID: ${m.authorId} • Message ID: ${m.messageId}`,
      },
      {
        actorId: m.authorId,
        channelId: m.channelId,
        data: { messageId: m.messageId, before: m.before, after: m.after },
      },
    );
  }

  async messageDeleted(m: {
    messageId: string;
    channelId: string;
    cached: CachedMessage | null;
  }): Promise<void> {
    const c = m.cached;
    const fields: NonNullable<ResultEmbed['fields']> = [
      {
        name: 'Content',
        value: c
          ? clip(c.content || '*(no text)*')
          : '*(not cached: sent before the bot started or evicted)*',
      },
    ];
    if (c?.attachments.length) {
      fields.push({ name: 'Attachments', value: clip(c.attachments.map((a) => a.name).join('\n')) });
    }
    await this.emit(
      'messages',
      'message_delete',
      c
        ? `Message by ${c.authorTag} deleted in <#${m.channelId}>`
        : `Uncached message deleted in <#${m.channelId}>`,
      {
        title: 'Message deleted',
        color: COLORS.danger,
        description: `In <#${m.channelId}>${c ? ` by <@${c.authorId}>` : ''}`,
        fields,
        footer: `${c ? `Author ID: ${c.authorId} • ` : ''}Message ID: ${m.messageId}`,
      },
      {
        actorId: c?.authorId ?? null,
        channelId: m.channelId,
        data: {
          messageId: m.messageId,
          content: c?.content ?? null,
          attachments: c?.attachments.map((a) => a.name) ?? [],
          cached: Boolean(c),
        },
      },
    );
  }

  async messagesBulkDeleted(m: { channelId: string; ids: string[]; cached: CachedMessage[] }): Promise<void> {
    const preview = m.cached
      .slice(0, 10)
      .map((c) => `**${c.authorTag}:** ${clip(c.content || '*(no text)*', 90)}`)
      .join('\n');
    await this.emit(
      'messages',
      'message_bulk_delete',
      `${m.ids.length} messages bulk deleted in <#${m.channelId}>`,
      {
        title: 'Messages bulk deleted',
        color: COLORS.danger,
        description: `${m.ids.length} messages in <#${m.channelId}> (${m.cached.length} cached)`,
        ...(preview ? { fields: [{ name: 'Preview', value: clip(preview) }] } : {}),
      },
      {
        channelId: m.channelId,
        data: {
          count: m.ids.length,
          messages: m.cached.map((c) => ({ id: c.id, authorId: c.authorId, content: c.content })),
        },
      },
    );
  }

  // ── Voice ────────────────────────────────────────────────────────────────

  async voiceChanged(m: {
    userId: string;
    tag: string;
    from: string | null;
    to: string | null;
  }): Promise<void> {
    if (m.from === m.to) return;
    const [event, title, summary, color] =
      m.from && m.to
        ? (['voice_move', 'Moved voice channel', `<#${m.from}> → <#${m.to}>`, COLORS.info] as const)
        : m.to
          ? (['voice_join', 'Joined voice', `joined <#${m.to}>`, COLORS.success] as const)
          : (['voice_leave', 'Left voice', `left <#${m.from}>`, COLORS.danger] as const);
    await this.emit(
      'voice',
      event,
      `${m.tag} ${summary}`,
      { title, color, description: `<@${m.userId}> ${summary}`, footer: `User ID: ${m.userId}` },
      { actorId: m.userId, channelId: m.to ?? m.from, data: { from: m.from, to: m.to } },
    );
  }

  // ── Server ───────────────────────────────────────────────────────────────

  async memberRolesChanged(m: {
    userId: string;
    tag: string;
    added: string[];
    removed: string[];
  }): Promise<void> {
    if (!m.added.length && !m.removed.length) return;
    const parts = [
      ...(m.added.length ? [`+${m.added.map((r) => `<@&${r}>`).join(' ')}`] : []),
      ...(m.removed.length ? [`−${m.removed.map((r) => `<@&${r}>`).join(' ')}`] : []),
    ];
    await this.emit(
      'server',
      'member_roles_change',
      `${m.tag} roles: ${parts.join(' ')}`,
      {
        title: 'Member roles changed',
        color: COLORS.info,
        description: `<@${m.userId}>`,
        fields: [
          ...(m.added.length
            ? [{ name: 'Added', value: m.added.map((r) => `<@&${r}>`).join(' '), inline: true }]
            : []),
          ...(m.removed.length
            ? [{ name: 'Removed', value: m.removed.map((r) => `<@&${r}>`).join(' '), inline: true }]
            : []),
        ],
        footer: `User ID: ${m.userId}`,
      },
      { targetId: m.userId, data: { added: m.added, removed: m.removed } },
    );
  }

  async roleEvent(
    kind: 'create' | 'delete' | 'update',
    role: RoleSnapshot,
    changes: string[] = [],
  ): Promise<void> {
    if (kind === 'update' && changes.length === 0) return;
    const title = { create: 'Role created', delete: 'Role deleted', update: 'Role updated' }[kind];
    await this.emit(
      'server',
      `role_${kind}`,
      `${title}: ${role.name}${changes.length ? ` (${changes.join('; ')})` : ''}`,
      {
        title,
        color: kind === 'delete' ? COLORS.danger : kind === 'create' ? COLORS.success : COLORS.info,
        description: kind === 'delete' ? `**${role.name}**` : `<@&${role.id}> (${role.name})`,
        ...(changes.length ? { fields: [{ name: 'Changes', value: clip(changes.join('\n')) }] } : {}),
        footer: `Role ID: ${role.id}`,
      },
      { targetId: role.id, data: { role, changes } },
    );
  }

  async channelEvent(
    kind: 'create' | 'delete' | 'update',
    ch: ChannelSnapshot,
    changes: string[] = [],
  ): Promise<void> {
    if (kind === 'update' && changes.length === 0) return;
    const title = { create: 'Channel created', delete: 'Channel deleted', update: 'Channel updated' }[kind];
    await this.emit(
      'server',
      `channel_${kind}`,
      `${title}: #${ch.name}${changes.length ? ` (${changes.join('; ')})` : ''}`,
      {
        title,
        color: kind === 'delete' ? COLORS.danger : kind === 'create' ? COLORS.success : COLORS.info,
        description: kind === 'delete' ? `**#${ch.name}** (${ch.kind})` : `<#${ch.id}> (${ch.kind})`,
        ...(changes.length ? { fields: [{ name: 'Changes', value: clip(changes.join('\n')) }] } : {}),
        footer: `Channel ID: ${ch.id}`,
      },
      { channelId: ch.id, data: { name: ch.name, kind: ch.kind, changes } },
    );
  }
}
