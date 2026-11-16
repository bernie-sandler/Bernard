import { allCommands } from '../src/bot/commands/index.js';
import { openDb, runMigrations } from '../src/db/client.js';
import type {
  BotInfoPort,
  ChannelInfo,
  GuildPort,
  GuildSummary,
  LockState,
  MemberInfo,
  MessageSummary,
  MessengerPort,
  ModerationPort,
  RoleInfo,
  UserInfo,
} from '../src/discord/ports.js';
import { nullLogger } from '../src/logger.js';
import type { Actor, CommandDefinition } from '../src/services/commands/types.js';
import { createContainer } from '../src/services/container.js';
import type { ResultEmbed } from '../src/shared/commandResult.js';

export const GUILD_ID = '100000000000000001';
export const OWNER_ID = '200000000000000001';
export const BOT_ID = '200000000000000002';

let seq = 300000000000000000n;
/** Unique snowflake-shaped ID. */
export const sid = (): string => (seq++).toString();

export function memoryDb() {
  const handle = openDb(':memory:');
  runMigrations(handle, 'src/db/migrations');
  return handle;
}

export class FakeGuild implements GuildPort {
  readonly guildId = GUILD_ID;
  members = new Map<string, MemberInfo>();
  roles = new Map<string, RoleInfo>();
  channels = new Map<string, ChannelInfo>();
  botRolePosition = 50;

  ownerId(): string {
    return OWNER_ID;
  }
  summary(): GuildSummary {
    return {
      id: GUILD_ID,
      name: 'Test Server',
      ownerId: OWNER_ID,
      iconUrl: null,
      createdAt: new Date('2020-01-01T00:00:00Z'),
      memberCount: this.members.size,
      roleCount: this.roles.size + 1,
      channelCounts: { text: 1, voice: 1, category: 1, other: 0 },
      boostTier: 0,
      boostCount: 0,
    };
  }
  async getMember(userId: string): Promise<MemberInfo | null> {
    return this.members.get(userId) ?? null;
  }
  async getUser(userId: string): Promise<UserInfo | null> {
    const m = this.members.get(userId);
    return m
      ? { userId, username: m.username, avatarUrl: null, isBot: m.isBot, createdAt: m.createdAt }
      : {
          userId,
          username: `ghost${userId.slice(-4)}`,
          avatarUrl: null,
          isBot: false,
          createdAt: new Date('2021-01-01'),
        };
  }
  getRole(roleId: string): RoleInfo | null {
    return this.roles.get(roleId) ?? null;
  }
  getChannel(channelId: string): ChannelInfo | null {
    return this.channels.get(channelId) ?? null;
  }
  roleName(roleId: string): string {
    if (roleId === GUILD_ID) return '@everyone';
    return `@${this.roles.get(roleId)?.name ?? roleId}`;
  }
  botMember() {
    return { userId: BOT_ID, highestRolePosition: this.botRolePosition };
  }
  addRole(name: string, position = 1, extra: Partial<RoleInfo> = {}): string {
    const id = sid();
    this.roles.set(id, { id, name, position, managed: false, color: 0, ...extra });
    return id;
  }
  addChannel(name: string, kind: ChannelInfo['kind'] = 'text'): string {
    const id = sid();
    this.channels.set(id, { id, name, kind, parentId: null });
    return id;
  }
  addMember(partial: Partial<MemberInfo> = {}): MemberInfo {
    const userId = partial.userId ?? sid();
    const m: MemberInfo = {
      userId,
      username: `user${userId.slice(-4)}`,
      displayName: `User ${userId.slice(-4)}`,
      avatarUrl: null,
      isBot: false,
      roleIds: [GUILD_ID],
      isOwner: userId === OWNER_ID,
      isAdministrator: false,
      highestRolePosition: 0,
      joinedAt: new Date('2024-01-01T00:00:00Z'),
      createdAt: new Date('2022-01-01T00:00:00Z'),
      communicationDisabledUntil: null,
      nickname: null,
      ...partial,
    };
    if (!m.roleIds.includes(GUILD_ID)) m.roleIds = [GUILD_ID, ...m.roleIds];
    this.members.set(userId, m);
    return m;
  }
}

/** Records every call; keeps just enough state (bans, timeouts, roles, messages) to be realistic. */
export class FakeModeration implements ModerationPort {
  calls: { method: string; args: unknown[] }[] = [];
  banned = new Set<string>();
  dmsOpen = true;
  messages = new Map<string, MessageSummary[]>();
  lockState: LockState = { SendMessages: null };

  constructor(private readonly guild: FakeGuild) {}

  private log(method: string, ...args: unknown[]) {
    this.calls.push({ method, args });
  }
  callsTo(method: string) {
    return this.calls.filter((c) => c.method === method);
  }

  async ban(userId: string, opts: { reason?: string; deleteMessageSeconds?: number }) {
    this.log('ban', userId, opts);
    this.banned.add(userId);
    this.guild.members.delete(userId);
  }
  async unban(userId: string, reason?: string) {
    this.log('unban', userId, reason);
    this.banned.delete(userId);
  }
  async isBanned(userId: string) {
    return this.banned.has(userId);
  }
  async kick(userId: string, reason?: string) {
    this.log('kick', userId, reason);
    this.guild.members.delete(userId);
  }
  async timeout(userId: string, ms: number | null, reason?: string) {
    this.log('timeout', userId, ms, reason);
    const m = this.guild.members.get(userId);
    if (m) m.communicationDisabledUntil = ms ? new Date(Date.now() + ms) : null;
  }
  async setNickname(userId: string, nickname: string | null, reason?: string) {
    this.log('setNickname', userId, nickname, reason);
    const m = this.guild.members.get(userId);
    if (m) m.nickname = nickname;
  }
  async addRole(userId: string, roleId: string, reason?: string) {
    this.log('addRole', userId, roleId, reason);
    this.guild.members.get(userId)?.roleIds.push(roleId);
  }
  async removeRole(userId: string, roleId: string, reason?: string) {
    this.log('removeRole', userId, roleId, reason);
    const m = this.guild.members.get(userId);
    if (m) m.roleIds = m.roleIds.filter((r) => r !== roleId);
  }
  async fetchMessages(channelId: string, limit: number, before?: string) {
    this.log('fetchMessages', channelId, limit, before);
    const all = this.messages.get(channelId) ?? [];
    const start = before ? all.findIndex((m) => m.id === before) + 1 : 0;
    return all.slice(start, start + limit);
  }
  async deleteMessages(channelId: string, ids: string[]) {
    this.log('deleteMessages', channelId, ids);
    return ids.length;
  }
  async setSlowmode(channelId: string, seconds: number, reason?: string) {
    this.log('setSlowmode', channelId, seconds, reason);
  }
  async setLocked(channelId: string, locked: boolean, previous?: LockState, reason?: string) {
    this.log('setLocked', channelId, locked, previous, reason);
    const before = { ...this.lockState };
    this.lockState = locked ? { SendMessages: false } : { SendMessages: previous?.SendMessages ?? null };
    return before;
  }
  async sendMessage(channelId: string, msg: { content?: string; embed?: ResultEmbed }) {
    this.log('sendMessage', channelId, msg);
    return sid();
  }
  async dm(userId: string, text: string) {
    this.log('dm', userId, text);
    return this.dmsOpen;
  }
}

export class FakeMessenger implements MessengerPort {
  sent: { channelId: string; embed: ResultEmbed }[] = [];
  fail = false;
  async sendEmbed(channelId: string, embed: ResultEmbed): Promise<string | null> {
    if (this.fail) throw new Error('send failed');
    this.sent.push({ channelId, embed });
    return sid();
  }
}

export class FakeBot implements BotInfoPort {
  isReady() {
    return true;
  }
  wsPingMs() {
    return 42;
  }
  uptimeMs() {
    return 5 * 60_000;
  }
  userId() {
    return BOT_ID;
  }
}

export function makeActor(member: MemberInfo): Actor {
  return {
    userId: member.userId,
    username: member.username,
    displayName: member.displayName,
    roleIds: member.roleIds,
    isOwner: member.isOwner,
    isAdministrator: member.isAdministrator,
    highestRolePosition: member.highestRolePosition,
  };
}

export function testContainer(commands: CommandDefinition[] = allCommands) {
  const dbHandle = memoryDb();
  const guild = new FakeGuild();
  const messenger = new FakeMessenger();
  const mod = new FakeModeration(guild);
  const container = createContainer({
    db: dbHandle.db,
    logger: nullLogger,
    guild,
    messenger,
    mod,
    bot: new FakeBot(),
    commands,
  });
  return { ...container, guild, messenger, mod, db: dbHandle.db, close: dbHandle.close };
}
