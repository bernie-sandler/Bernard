import { allCommands } from '../src/bot/commands/index.js';
import { openDb, runMigrations } from '../src/db/client.js';
import type { BotInfoPort, GuildPort, MemberInfo, MessengerPort, RoleInfo } from '../src/discord/ports.js';
import { nullLogger } from '../src/logger.js';
import type { Actor, CommandDefinition } from '../src/services/commands/types.js';
import { createContainer } from '../src/services/container.js';
import type { ResultEmbed } from '../src/shared/commandResult.js';

export const GUILD_ID = '100000000000000001';
export const OWNER_ID = '200000000000000001';

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
  ownerId(): string {
    return OWNER_ID;
  }
  async getMember(userId: string): Promise<MemberInfo | null> {
    return this.members.get(userId) ?? null;
  }
  getRole(roleId: string): RoleInfo | null {
    return this.roles.get(roleId) ?? null;
  }
  roleName(roleId: string): string {
    if (roleId === GUILD_ID) return '@everyone';
    return `@${this.roles.get(roleId)?.name ?? roleId}`;
  }
  addRole(name: string, position = 1): string {
    const id = sid();
    this.roles.set(id, { id, name, position, managed: false, color: 0 });
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
      ...partial,
    };
    if (!m.roleIds.includes(GUILD_ID)) m.roleIds = [GUILD_ID, ...m.roleIds];
    this.members.set(userId, m);
    return m;
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
  const container = createContainer({
    db: dbHandle.db,
    logger: nullLogger,
    guild,
    messenger,
    bot: new FakeBot(),
    commands,
  });
  return { ...container, guild, messenger, db: dbHandle.db, close: dbHandle.close };
}
