import type { ResultEmbed } from '../shared/commandResult.js';

/**
 * Narrow interfaces the services depend on instead of raw discord.js objects. Production uses the
 * adapters in ./adapters.ts; tests use in-memory fakes.
 */

export interface MemberInfo {
  userId: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  isBot: boolean;
  /** Includes the @everyone role ID (= guild ID). */
  roleIds: string[];
  isOwner: boolean;
  isAdministrator: boolean;
  highestRolePosition: number;
  joinedAt: Date | null;
  /** Account creation date. */
  createdAt: Date;
  /** Set while the member is timed out. */
  communicationDisabledUntil: Date | null;
  nickname: string | null;
}

export interface UserInfo {
  userId: string;
  username: string;
  avatarUrl: string | null;
  isBot: boolean;
  createdAt: Date;
}

export interface RoleInfo {
  id: string;
  name: string;
  position: number;
  managed: boolean;
  color: number;
}

export type ChannelKindName =
  | 'text'
  | 'voice'
  | 'category'
  | 'announcement'
  | 'stage'
  | 'forum'
  | 'thread'
  | 'other';

export interface ChannelInfo {
  id: string;
  name: string;
  kind: ChannelKindName;
  parentId: string | null;
}

export interface GuildSummary {
  id: string;
  name: string;
  ownerId: string;
  iconUrl: string | null;
  createdAt: Date;
  memberCount: number;
  roleCount: number;
  channelCounts: { text: number; voice: number; category: number; other: number };
  boostTier: number;
  boostCount: number;
}

export interface GuildPort {
  readonly guildId: string;
  ownerId(): string;
  summary(): GuildSummary;
  getMember(userId: string): Promise<MemberInfo | null>;
  getUser(userId: string): Promise<UserInfo | null>;
  getRole(roleId: string): RoleInfo | null;
  getChannel(channelId: string): ChannelInfo | null;
  /** "@everyone" for the guild ID, "@Name" for known roles, otherwise a mention-ish fallback. */
  roleName(roleId: string): string;
  /** The bot's own member: ID and highest role position. */
  botMember(): { userId: string; highestRolePosition: number };
}

export interface MessageSummary {
  id: string;
  authorId: string;
  createdAt: Date;
  pinned: boolean;
}

/** Channel permission bits touched by /lock, as their previous @everyone overwrite state. */
export type LockState = Record<string, boolean | null>;

export interface ModerationPort {
  ban(userId: string, opts: { reason?: string; deleteMessageSeconds?: number }): Promise<void>;
  unban(userId: string, reason?: string): Promise<void>;
  isBanned(userId: string): Promise<boolean>;
  kick(userId: string, reason?: string): Promise<void>;
  /** ms = null clears the timeout. */
  timeout(userId: string, ms: number | null, reason?: string): Promise<void>;
  setNickname(userId: string, nickname: string | null, reason?: string): Promise<void>;
  addRole(userId: string, roleId: string, reason?: string): Promise<void>;
  removeRole(userId: string, roleId: string, reason?: string): Promise<void>;
  /** Newest first, at most 100, optionally older than `before`. */
  fetchMessages(channelId: string, limit: number, before?: string): Promise<MessageSummary[]>;
  /** Delete messages (all must be younger than 14 days). Returns how many were deleted. */
  deleteMessages(channelId: string, ids: string[], reason?: string): Promise<number>;
  setSlowmode(channelId: string, seconds: number, reason?: string): Promise<void>;
  /** Lock: deny send perms for @everyone and return the previous state. Unlock: restore `previous` (or inherit). */
  setLocked(channelId: string, locked: boolean, previous?: LockState, reason?: string): Promise<LockState>;
  sendMessage(channelId: string, msg: { content?: string; embed?: ResultEmbed }): Promise<string>;
  /** Best-effort DM. Returns false when the user has DMs closed. */
  dm(userId: string, text: string): Promise<boolean>;
}

export interface MessengerPort {
  /** Send an embed to a channel. Returns the message ID, or null if it could not be sent. */
  sendEmbed(channelId: string, embed: ResultEmbed): Promise<string | null>;
}

export interface BotInfoPort {
  isReady(): boolean;
  wsPingMs(): number;
  uptimeMs(): number;
  /** The bot's user ID once logged in. */
  userId(): string | null;
}
