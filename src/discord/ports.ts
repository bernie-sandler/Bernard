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
}

export interface RoleInfo {
  id: string;
  name: string;
  position: number;
  managed: boolean;
  color: number;
}

export interface GuildPort {
  readonly guildId: string;
  ownerId(): string;
  getMember(userId: string): Promise<MemberInfo | null>;
  getRole(roleId: string): RoleInfo | null;
  /** "@everyone" for the guild ID, "@Name" for known roles, otherwise a mention-ish fallback. */
  roleName(roleId: string): string;
}

export interface MessengerPort {
  /** Send an embed to a channel. Returns the message ID, or null if it could not be sent. */
  sendEmbed(channelId: string, embed: ResultEmbed): Promise<string | null>;
}

export interface BotInfoPort {
  isReady(): boolean;
  wsPingMs(): number;
  uptimeMs(): number;
}
