import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { auditLog } from '../src/db/schema.js';
import { RENAME_WINDOW_MS, renameWaitMs, renderChannelName } from '../src/services/voice.js';
import { makeActor, OWNER_ID, sid, testContainer } from './helpers.js';

let t: ReturnType<typeof testContainer>;
let category: string;
let hub: string;
const ADMIN = { id: OWNER_ID, source: 'slash' as const };

const svc = () => t.services.voice;
const nameOf = (id: string) => `User${id.slice(-3)}`;

/** Deliver gateway events queued by the fake port (e.g. the move into a new channel). */
async function flush() {
  while (t.voice.pending.length) {
    const e = t.voice.pending.shift()!;
    await svc().handleVoiceStateUpdate({
      userId: e.userId,
      displayName: nameOf(e.userId),
      username: `u${e.userId.slice(-3)}`,
      isBot: t.voice.bots.has(e.userId),
      from: e.from,
      to: e.to,
    });
  }
}

/** A member connects to (or, with null, disconnects from) a voice channel on their own. */
async function connect(userId: string, to: string | null) {
  const from = t.voice.states.get(userId) ?? null;
  if (to) t.voice.states.set(userId, to);
  else t.voice.states.delete(userId);
  await svc().handleVoiceStateUpdate({
    userId,
    displayName: nameOf(userId),
    username: `u${userId.slice(-3)}`,
    isBot: t.voice.bots.has(userId),
    from,
    to,
  });
  await flush();
}

const setVoice = (patch: Partial<ReturnType<typeof t.services.settings.get>['voice']>) =>
  t.services.settings.update(ADMIN, 'test', (s) => {
    Object.assign(s.voice, patch);
  });

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-06-01T12:00:00Z'));
  t = testContainer();
  category = t.voice.addVoiceChannel('Temp', 'category');
  hub = t.voice.addVoiceChannel('➕ Join to create');
  svc().addHub(ADMIN, {
    channelId: hub,
    type: 'public',
    categoryId: category,
    nameTemplate: '{user} #{count}',
  });
});
afterEach(() => {
  svc().stop();
  t.close();
  vi.useRealTimers();
});

/** Join the hub and return the created channel. */
async function createVia(userId: string) {
  await connect(userId, hub);
  return t.voice.states.get(userId)!;
}

describe('helpers', () => {
  it('renders templates', () => {
    expect(renderChannelName("{user}'s Channel", { user: 'Ana', username: 'ana', count: 1 })).toBe(
      "Ana's Channel",
    );
    expect(renderChannelName('{username} #{count}', { user: 'Ana', username: 'ana', count: 3 })).toBe(
      'ana #3',
    );
    expect(renderChannelName('   ', { user: 'A', username: 'a', count: 1 })).toBe('Voice Channel');
    expect(renderChannelName('x'.repeat(150), { user: 'A', username: 'a', count: 1 })).toHaveLength(100);
  });

  it('computes rename waits over a sliding 10 minute window', () => {
    const now = 1_000_000_000;
    expect(renameWaitMs([], now)).toBe(0);
    expect(renameWaitMs([now - 60_000], now)).toBe(0);
    expect(renameWaitMs([now - 60_000, now - 30_000], now)).toBe(RENAME_WINDOW_MS - 60_000);
    expect(renameWaitMs([now - RENAME_WINDOW_MS - 1, now - 30_000], now)).toBe(0);
  });
});

describe('join-to-create lifecycle', () => {
  it('creates a channel in the hub category, makes the joiner owner and moves them in', async () => {
    const user = sid();
    const ch = await createVia(user);
    expect(ch).not.toBe(hub);
    const created = t.voice.created[0]!;
    expect(created.opts).toMatchObject({
      name: `${nameOf(user)} #1`,
      categoryId: category,
      ownerId: user,
      denyEveryoneConnect: false,
    });
    expect(svc().getTemp(ch)).toMatchObject({ ownerId: user, hubChannelId: hub });
    expect(
      svc()
        .getTemp(ch)!
        .occupants.map((o) => o.userId),
    ).toEqual([user]);
  });

  it('private hubs deny @everyone Connect (and can hide the channel)', async () => {
    const priv = t.voice.addVoiceChannel('🔒 Private');
    svc().addHub(ADMIN, { channelId: priv, type: 'private', categoryId: category, hideFromEveryone: true });
    await connect(sid(), priv);
    expect(t.voice.created[0]!.opts).toMatchObject({ denyEveryoneConnect: true, hideFromEveryone: true });
  });

  it('deletes an empty channel after the grace period', async () => {
    const user = sid();
    const ch = await createVia(user);
    await connect(user, null);
    expect(t.voice.channelExists(ch)).toBe(true);
    await vi.advanceTimersByTimeAsync(9_000);
    expect(t.voice.channelExists(ch)).toBe(true);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(t.voice.channelExists(ch)).toBe(false);
    expect(svc().getTemp(ch)).toBeUndefined();
    expect(svc().isManagedChannel(ch)).toBe(true); // recently deleted: stays out of the server log
  });

  it('a reconnect during the grace period cancels deletion', async () => {
    const user = sid();
    const ch = await createVia(user);
    await connect(user, null);
    await vi.advanceTimersByTimeAsync(5_000);
    await connect(user, ch);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(t.voice.channelExists(ch)).toBe(true);
  });

  it('deletes immediately when the grace period is 0', async () => {
    setVoice({ graceSeconds: 0 });
    const user = sid();
    const ch = await createVia(user);
    await connect(user, null);
    expect(t.voice.deleted).toEqual([ch]);
  });

  it('moving between temp channels is handled as a leave plus a join', async () => {
    const a = sid();
    const b = sid();
    const chA = await createVia(a);
    const chB = await createVia(b);
    await connect(a, chB);
    await vi.advanceTimersByTimeAsync(11_000);
    expect(t.voice.channelExists(chA)).toBe(false);
    expect(
      svc()
        .getTemp(chB)!
        .occupants.map((o) => o.userId),
    ).toEqual([b, a]);
  });

  it('ignores bots', async () => {
    const bot = sid();
    t.voice.bots.add(bot);
    await connect(bot, hub);
    expect(t.voice.created).toHaveLength(0);
  });
});

describe('ownership', () => {
  it('transfers to the longest-present member when the owner leaves', async () => {
    const owner = sid();
    const first = sid();
    const second = sid();
    const ch = await createVia(owner);
    await connect(first, ch);
    vi.advanceTimersByTime(1000);
    await connect(second, ch);
    await connect(owner, null);
    expect(svc().getTemp(ch)!.ownerId).toBe(first);
    expect(t.voice.overwrites.get(ch)!.get(first)).toBe('allow');
    expect(t.voice.notices.at(-1)!.text).toMatch(new RegExp(`<@${first}> now owns`));
  });

  it('in claim mode the channel becomes ownerless until someone claims it', async () => {
    setVoice({ ownerLeaveMode: 'claim' });
    const owner = sid();
    const member = sid();
    const ch = await createVia(owner);
    await connect(member, ch);
    await expect(svc().claim(member)).rejects.toThrow('still here');
    await connect(owner, null);
    expect(svc().getTemp(ch)!.ownerId).toBeNull();
    await expect(svc().lock(member)).rejects.toThrow('/vc claim');
    await svc().claim(member);
    expect(svc().getTemp(ch)!.ownerId).toBe(member);
    await expect(svc().claim(member)).rejects.toThrow('already own');
  });

  it('transfer requires the new owner to be in the channel', async () => {
    const owner = sid();
    const ch = await createVia(owner);
    await expect(svc().transfer(owner, sid())).rejects.toThrow('someone in the channel');
    const other = sid();
    await connect(other, ch);
    await svc().transfer(owner, other);
    expect(svc().getTemp(ch)!.ownerId).toBe(other);
    await expect(svc().rename(owner, 'mine')).rejects.toThrow('Only the channel owner');
  });
});

describe('owner commands', () => {
  it('require being in your own temp channel', async () => {
    await expect(svc().lock(sid())).rejects.toThrow('Join your temporary voice channel first');
    const user = sid();
    t.voice.states.set(user, hub);
    await expect(svc().lock(user)).rejects.toThrow('not in a temporary voice channel');
  });

  it('lock lets people already inside reconnect; unlock reopens', async () => {
    const owner = sid();
    const guest = sid();
    const ch = await createVia(owner);
    await connect(guest, ch);
    await svc().lock(owner);
    expect(t.voice.everyoneDenied.get(ch)).toBe(true);
    expect(t.voice.overwrites.get(ch)!.get(guest)).toBe('allow');
    await svc().unlock(owner);
    expect(t.voice.everyoneDenied.get(ch)).toBe(false);
  });

  it('limits renames to 2 per 10 minutes with a friendly wait', async () => {
    const owner = sid();
    const ch = await createVia(owner);
    await svc().rename(owner, 'One');
    vi.advanceTimersByTime(60_000);
    await svc().rename(owner, 'Two');
    await expect(svc().rename(owner, 'Three')).rejects.toThrow('Try again in 9 minutes');
    vi.advanceTimersByTime(9 * 60_000);
    await svc().rename(owner, 'Three');
    expect(t.voice.names.get(ch)).toBe('Three');
    await expect(svc().rename(owner, '   ')).rejects.toThrow('1-100 characters');
  });

  it('kick blocks and disconnects; invite allows', async () => {
    const owner = sid();
    const guest = sid();
    const ch = await createVia(owner);
    await connect(guest, ch);
    const r = await svc().kick(owner, guest);
    expect(r.disconnected).toBe(true);
    expect(t.voice.overwrites.get(ch)!.get(guest)).toBe('deny');
    expect(t.voice.states.has(guest)).toBe(false);
    await svc().invite(owner, guest);
    expect(t.voice.overwrites.get(ch)!.get(guest)).toBe('allow');
    await expect(svc().kick(owner, owner)).rejects.toThrow("can't kick yourself");
  });

  it('validates the user limit', async () => {
    const owner = sid();
    const ch = await createVia(owner);
    await svc().setLimit(owner, 5);
    expect(t.voice.limits.get(ch)).toBe(5);
    await expect(svc().setLimit(owner, 100)).rejects.toThrow('0 (unlimited) to 99');
  });
});

describe('abuse protection and failures', () => {
  it('enforces the per-user hub cooldown', async () => {
    setVoice({ graceSeconds: 0, hubCooldownSeconds: 30 });
    const user = sid();
    await createVia(user);
    await connect(user, null);
    await connect(user, hub);
    expect(t.voice.created).toHaveLength(1);
    expect(t.voice.states.has(user)).toBe(false); // disconnected from the hub
    expect(t.voice.notices.at(-1)).toMatchObject({ channelId: hub, text: expect.stringMatching(/wait 30s/) });
    vi.advanceTimersByTime(30_000);
    await connect(user, hub);
    expect(t.voice.created).toHaveLength(2);
  });

  it('an owner hopping from their channel to the hub hands it over, then gets a new one', async () => {
    setVoice({ hubCooldownSeconds: 0 });
    const owner = sid();
    const ch = await createVia(owner);
    const guest = sid();
    await connect(guest, ch); // keeps the channel alive
    await connect(owner, hub);
    expect(svc().getTemp(ch)!.ownerId).toBe(guest);
    expect(t.voice.created).toHaveLength(2);
    expect(t.voice.states.get(owner)).toBe(t.voice.created[1]!.id);
  });

  it('deletes the new channel if the user left before being moved', async () => {
    const user = sid();
    t.voice.failMove = true;
    t.voice.states.set(user, hub);
    await svc().handleVoiceStateUpdate({
      userId: user,
      displayName: 'x',
      username: 'x',
      isBot: false,
      from: null,
      to: hub,
    });
    expect(t.voice.created).toHaveLength(1);
    expect(t.voice.deleted).toEqual([t.voice.created[0]!.id]);
    expect(svc().listTemps()).toHaveLength(0);
  });

  it('tells the user when the channel cannot be created', async () => {
    t.voice.failCreate = true;
    await connect(sid(), hub);
    expect(svc().listTemps()).toHaveLength(0);
    expect(t.voice.notices.at(-1)!.text).toMatch(/couldn't create a channel/);
  });
});

describe('startup reconcile', () => {
  it('drops missing channels, deletes empty ones, fixes ownership and adopts hub waiters', async () => {
    const owner = sid();
    const guest = sid();
    const live = await createVia(owner);
    await connect(guest, live);
    const empty = await createVia(sid());
    const gone = await createVia(sid());
    // Simulate a restart: state changed while the bot was offline.
    for (const [u, c] of [...t.voice.states.entries()])
      if (c === empty || c === gone) t.voice.states.delete(u);
    t.voice.states.delete(owner);
    t.voice.existing.delete(gone);
    const waiter = t.guild.addMember();
    t.voice.states.set(waiter.userId, hub);

    const result = await svc().reconcile();
    expect(result).toEqual({ deleted: 1, dropped: 1, adopted: 1 });
    expect(svc().getTemp(gone)).toBeUndefined();
    expect(svc().getTemp(empty)).toBeUndefined();
    expect(t.voice.channelExists(empty)).toBe(false);
    expect(svc().getTemp(live)!.ownerId).toBe(guest);
    expect(
      svc()
        .listTemps()
        .some((r) => r.ownerId === waiter.userId),
    ).toBe(true);
  });

  it('keeps the record when Discord refuses the delete, so the next reconcile retries', async () => {
    setVoice({ graceSeconds: 0 });
    const user = sid();
    const ch = await createVia(user);
    t.voice.deleteChannel = async () => {
      throw new Error('Missing Permissions');
    };
    await connect(user, null);
    expect(svc().getTemp(ch)).toBeDefined();
  });
});

describe('hub configuration', () => {
  it('validates hubs and audits changes', () => {
    const text = t.guild.addChannel('general', 'text');
    const vc = t.voice.addVoiceChannel('Another');
    expect(() => svc().addHub(ADMIN, { channelId: text, type: 'public', categoryId: category })).toThrow(
      'voice channel',
    );
    expect(() => svc().addHub(ADMIN, { channelId: vc, type: 'public', categoryId: vc })).toThrow('category');
    expect(() => svc().addHub(ADMIN, { channelId: hub, type: 'public', categoryId: category })).toThrow(
      'already a hub',
    );
    expect(() =>
      svc().addHub(ADMIN, { channelId: vc, type: 'public', categoryId: category, defaultLimit: 120 }),
    ).toThrow('0 (unlimited) to 99');
    const edited = svc().editHub(ADMIN, hub, { type: 'private', defaultLimit: 4 });
    expect(edited).toMatchObject({ type: 'private', defaultLimit: 4 });
    const actions = t.db
      .select()
      .from(auditLog)
      .all()
      .map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['voice.hub.add', 'voice.hub.edit']));
  });

  it('removes a hub whose channel was deleted', () => {
    svc().onChannelDeleted(hub);
    expect(svc().getHub(hub)).toBeUndefined();
  });

  it('temp channels cannot become hubs', async () => {
    const ch = await createVia(sid());
    expect(() => svc().addHub(ADMIN, { channelId: ch, type: 'public', categoryId: category })).toThrow(
      'temporary',
    );
  });
});

describe('commands', () => {
  it('/vc from the dashboard explains that you must be in your channel', async () => {
    const member = t.guild.addMember();
    const res = await t.executor.run({
      command: t.services.registry.find('vc lock')!,
      actor: makeActor(member),
      source: 'dashboard',
      rawInput: {},
    });
    expect(res.result).toMatchObject({ ok: false, content: 'Join your temporary voice channel first.' });
  });

  it('/vc is open to @everyone by default; /voice needs config:voice', async () => {
    const member = t.guild.addMember();
    const vc = await t.executor.run({
      command: t.services.registry.find('vc claim')!,
      actor: makeActor(member),
      source: 'slash',
      rawInput: {},
    });
    expect(vc.outcome).not.toBe('denied');
    const cfg = await t.executor.run({
      command: t.services.registry.find('voice hub list')!,
      actor: makeActor(member),
      source: 'slash',
      rawInput: {},
    });
    expect(cfg.outcome).toBe('denied');
  });

  it('/voice settings updates and audits', async () => {
    const owner = t.guild.addMember({ userId: OWNER_ID });
    const res = await t.executor.run({
      command: t.services.registry.find('voice settings')!,
      actor: makeActor(owner),
      source: 'slash',
      rawInput: { grace_seconds: 20, owner_leave: 'claim' },
    });
    expect(res.result.ok).toBe(true);
    expect(t.services.settings.get().voice).toMatchObject({ graceSeconds: 20, ownerLeaveMode: 'claim' });
  });
});
