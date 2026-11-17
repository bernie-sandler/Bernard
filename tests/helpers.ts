import { allCommands } from '../src/bot/commands/index.js';
import { openDb, runMigrations } from '../src/db/client.js';
import type {
  BotInfoPort,
  ChannelInfo,
  CreateVoiceChannelOptions,
  GuildPort,
  GuildSummary,
  LockState,
  MemberInfo,
  MessageSummary,
  MessengerPort,
  ModerationPort,
  RoleInfo,
  UserInfo,
  VoicePort,
} from '../src/discord/ports.js';
import { nullLogger } from '../src/logger.js';
import type {
  BelltowerClient,
  ChangedTickets,
  ListedTicket,
  NewCard,
  OpenedCard,
  TicketInfo,
  TicketState,
} from '../src/services/belltower/client.js';
import { parseTicketPage } from '../src/services/belltower/client.js';
import type { Actor, CommandDefinition } from '../src/services/commands/types.js';
import { createContainer } from '../src/services/container.js';
import type { KumaClient, KumaSnapshot } from '../src/services/status/kuma.js';
import type { ResultEmbed } from '../src/shared/commandResult.js';
import type { OutgoingMessage } from '../src/shared/messages.js';

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
  listChannels(): ChannelInfo[] {
    return [...this.channels.values()];
  }
  roleName(roleId: string): string {
    if (roleId === GUILD_ID) return '@everyone';
    return `@${this.roles.get(roleId)?.name ?? roleId}`;
  }
  botMember() {
    return { userId: BOT_ID, highestRolePosition: this.botRolePosition };
  }
  async listMembers(): Promise<MemberInfo[]> {
    return [...this.members.values()];
  }
  cachedMember(userId: string): MemberInfo | null {
    return this.members.get(userId) ?? null;
  }
  listRoles(): RoleInfo[] {
    return [...this.roles.values()].sort((a, b) => b.position - a.position);
  }
  async approximateCounts() {
    return { members: this.members.size, online: Math.ceil(this.members.size / 2) };
  }
  roleMemberCount(roleId: string): number {
    return [...this.members.values()].filter((m) => m.roleIds.includes(roleId)).length;
  }
  addRole(name: string, position = 1, extra: Partial<RoleInfo> = {}): string {
    const id = sid();
    this.roles.set(id, { id, name, position, managed: false, color: 0, elevated: false, ...extra });
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
  /** Messages sent with send(), by ID (edits replace the stored message). */
  messages = new Map<string, { channelId: string; msg: OutgoingMessage; pinned: boolean }>();
  /** Channels send() treats as missing or not postable. */
  unsendable = new Set<string>();
  canPin = true;
  edits = 0;

  async sendEmbed(channelId: string, embed: ResultEmbed): Promise<string | null> {
    if (this.fail) throw new Error('send failed');
    this.sent.push({ channelId, embed });
    return sid();
  }
  async send(channelId: string, msg: OutgoingMessage): Promise<string | null> {
    if (this.fail) throw new Error('send failed');
    if (this.unsendable.has(channelId)) return null;
    const id = sid();
    this.messages.set(id, { channelId, msg, pinned: false });
    return id;
  }
  async edit(channelId: string, messageId: string, msg: OutgoingMessage): Promise<boolean> {
    const m = this.messages.get(messageId);
    if (!m || m.channelId !== channelId) return false;
    m.msg = msg;
    this.edits++;
    return true;
  }
  async pin(_channelId: string, messageId: string): Promise<boolean> {
    const m = this.messages.get(messageId);
    if (!m || !this.canPin) return false;
    m.pinned = true;
    return true;
  }
  async delete(_channelId: string, messageId: string): Promise<void> {
    this.messages.delete(messageId);
  }
  /** Messages currently in a channel, oldest first. */
  inChannel(channelId: string) {
    return [...this.messages.entries()]
      .filter(([, m]) => m.channelId === channelId)
      .map(([id, m]) => ({ id, ...m }));
  }
}

/** Uptime Kuma stand-in: set `snapshot`, or `error` to make reads fail. */
export class FakeKuma implements KumaClient {
  snapshot: KumaSnapshot = { title: 'Homelab', monitors: [] };
  error: Error | null = null;
  reads = 0;
  async fetchStatusPage(): Promise<KumaSnapshot> {
    this.reads++;
    if (this.error) throw this.error;
    return structuredClone(this.snapshot);
  }
}

/**
 * Belltower stand-in. openCard dedupes on dedupeKey like the real API; add a submit-page ticket with
 * submit, set a ticket's state with setState, remove it with `tickets.delete`, or set `error` to make
 * every call fail. `listChanged` answers like ?updatedSince= on a clock that `now` controls.
 */
export class FakeBelltower implements BelltowerClient {
  opened: NewCard[] = [];
  tickets = new Map<number, ListedTicket & { dedupeKey?: string }>();
  error: Error | null = null;
  reads = 0;
  /** The `since` of each listChanged call. */
  listed: string[] = [];
  /** Leave `source` out of listChanged answers, like Belltower before 1.6.0. */
  old = false;
  now = Date.now();
  private nextId = 1;

  private stamp(): string {
    return new Date(this.now).toISOString();
  }

  /** A ticket sent through the submit page. */
  submit(title: string, submitter: string | null = null): ListedTicket {
    const id = this.nextId++;
    const ticket: ListedTicket = {
      id,
      ticketNo: `261117-${id}`,
      title,
      state: 'received',
      resolution: null,
      archivedAt: null,
      deletedAt: null,
      createdAt: this.stamp(),
      updatedAt: this.stamp(),
      source: 'submit',
      submitter,
    };
    this.tickets.set(id, ticket);
    return ticket;
  }

  async listChanged(since: string): Promise<ChangedTickets> {
    this.reads++;
    this.listed.push(since);
    if (this.error) throw this.error;
    const cards = [...this.tickets.values()]
      .filter((t) => t.updatedAt >= since)
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt) || a.id - b.id)
      .map(({ dedupeKey: _key, source, submitter, ...t }) => (this.old ? t : { ...t, source, submitter }));
    // Through the real parser, so an old Belltower fails the way it would.
    const { tickets, generatedAt } = parseTicketPage({
      cards,
      more: false,
      next: null,
      generatedAt: this.stamp(),
    });
    return { tickets, generatedAt };
  }

  async openCard(card: NewCard): Promise<OpenedCard> {
    if (this.error) throw this.error;
    this.opened.push(card);
    if (card.dedupeKey) {
      for (const t of this.tickets.values()) {
        if (t.dedupeKey === card.dedupeKey && t.state !== 'done' && !t.deletedAt) {
          return { status: 'updated', id: t.id, ticketNo: t.ticketNo, title: t.title };
        }
      }
    }
    const id = this.nextId++;
    const ticket = {
      id,
      ticketNo: `261117-${id}`,
      title: card.title,
      state: 'received' as const,
      resolution: null,
      archivedAt: null,
      deletedAt: null,
      createdAt: this.stamp(),
      updatedAt: this.stamp(),
      source: 'api',
      submitter: null,
      ...(card.dedupeKey ? { dedupeKey: card.dedupeKey } : {}),
    };
    this.tickets.set(id, ticket);
    return { status: 'created', id, ticketNo: ticket.ticketNo, title: card.title };
  }
  async getCards(ids: number[]): Promise<TicketInfo[]> {
    this.reads++;
    if (this.error) throw this.error;
    return ids.flatMap((id) => {
      const t = this.tickets.get(id);
      if (!t) return [];
      const { id: _id, ticketNo, title, state, resolution, archivedAt, deletedAt } = t;
      return [{ id, ticketNo, title, state, resolution, archivedAt, deletedAt }];
    });
  }
  async ping(): Promise<void> {
    if (this.error) throw this.error;
  }
  setState(id: number, state: TicketState, resolution: string | null = null) {
    const t = this.tickets.get(id);
    if (!t) throw new Error(`no ticket ${id}`);
    t.state = state;
    t.resolution = resolution;
    t.updatedAt = this.stamp();
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

/** In-memory voice state. moveMember queues the gateway event; flushVoice() delivers queued events. */
export class FakeVoice implements VoicePort {
  states = new Map<string, string>();
  bots = new Set<string>();
  existing = new Set<string>();
  created: { id: string; opts: CreateVoiceChannelOptions }[] = [];
  deleted: string[] = [];
  overwrites = new Map<string, Map<string, 'allow' | 'deny'>>();
  everyoneDenied = new Map<string, boolean>();
  limits = new Map<string, number>();
  names = new Map<string, string>();
  notices: { channelId: string; text: string }[] = [];
  pending: { userId: string; from: string | null; to: string | null }[] = [];
  failCreate = false;
  failMove = false;
  deafened = new Set<string>();
  afk: string | null = null;

  snapshot() {
    const byChannel = new Map<
      string,
      { channelId: string; members: { userId: string; isBot: boolean; selfDeaf: boolean }[] }
    >();
    for (const [userId, channelId] of this.states) {
      const entry = byChannel.get(channelId) ?? { channelId, members: [] };
      entry.members.push({ userId, isBot: this.bots.has(userId), selfDeaf: this.deafened.has(userId) });
      byChannel.set(channelId, entry);
    }
    return [...byChannel.values()];
  }
  afkChannelId() {
    return this.afk;
  }

  constructor(private readonly guild: FakeGuild) {}

  addVoiceChannel(name: string, kind: ChannelInfo['kind'] = 'voice'): string {
    const id = this.guild.addChannel(name, kind);
    this.existing.add(id);
    return id;
  }
  async createVoiceChannel(opts: CreateVoiceChannelOptions) {
    if (this.failCreate) throw new Error('Maximum number of channels in category reached');
    const id = this.addVoiceChannel(opts.name);
    this.created.push({ id, opts });
    this.names.set(id, opts.name);
    this.everyoneDenied.set(id, opts.denyEveryoneConnect);
    this.limits.set(id, opts.userLimit);
    this.overwrites.set(id, new Map([[opts.ownerId, 'allow']]));
    return id;
  }
  async deleteChannel(channelId: string) {
    this.existing.delete(channelId);
    this.guild.channels.delete(channelId);
    this.deleted.push(channelId);
  }
  async moveMember(userId: string, channelId: string | null) {
    if (this.failMove) throw new Error('Target user is not connected to voice');
    const from = this.states.get(userId) ?? null;
    if (channelId) this.states.set(userId, channelId);
    else this.states.delete(userId);
    this.pending.push({ userId, from, to: channelId });
  }
  channelExists(channelId: string) {
    return this.existing.has(channelId);
  }
  channelMembers(channelId: string) {
    return [...this.states.entries()]
      .filter(([u, c]) => c === channelId && !this.bots.has(u))
      .map(([u]) => u);
  }
  memberVoiceChannel(userId: string) {
    return this.states.get(userId) ?? null;
  }
  async setUserLimit(channelId: string, limit: number) {
    this.limits.set(channelId, limit);
  }
  async rename(channelId: string, name: string) {
    this.names.set(channelId, name);
  }
  async setEveryoneDenied(channelId: string, denied: boolean) {
    this.everyoneDenied.set(channelId, denied);
  }
  async setMemberAccess(channelId: string, userId: string, access: 'allow' | 'deny' | null) {
    const map = this.overwrites.get(channelId) ?? new Map();
    if (access) map.set(userId, access);
    else map.delete(userId);
    this.overwrites.set(channelId, map);
  }
  async notify(channelId: string, text: string) {
    this.notices.push({ channelId, text });
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

export function testContainer(
  commands: CommandDefinition[] = allCommands,
  opts: { belltower?: boolean } = {},
) {
  const dbHandle = memoryDb();
  const guild = new FakeGuild();
  const messenger = new FakeMessenger();
  const mod = new FakeModeration(guild);
  const voice = new FakeVoice(guild);
  const kuma = new FakeKuma();
  const belltower = new FakeBelltower();
  const container = createContainer({
    db: dbHandle.db,
    logger: nullLogger,
    guild,
    messenger,
    mod,
    voice,
    bot: new FakeBot(),
    commands,
    kuma,
    belltower: opts.belltower === false ? null : belltower,
  });
  return {
    ...container,
    guild,
    messenger,
    mod,
    voice,
    kuma,
    belltower,
    db: dbHandle.db,
    close: dbHandle.close,
  };
}
