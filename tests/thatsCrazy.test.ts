import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Settings } from '../src/config/settings.js';
import { auditLog } from '../src/db/schema.js';
import type { MemberInfo } from '../src/discord/ports.js';
import { CRAZY_VOTE_PREFIX, parseCrazyVoteId } from '../src/services/thatsCrazy.js';
import { makeActor, OWNER_ID, testContainer } from './helpers.js';

let t: ReturnType<typeof testContainer>;
let channel: string;
let vc: string;
let target: MemberInfo;
let a: MemberInfo;
let b: MemberInfo;
let c: MemberInfo;
const ADMIN = { id: OWNER_ID, source: 'slash' as const };

const svc = () => t.services.thatsCrazy;
const MIN = 60_000;

function configure(patch: Partial<Settings['thatsCrazy']> = {}) {
  t.services.settings.update(ADMIN, 'test', (s) => {
    Object.assign(s.thatsCrazy, {
      enabled: true,
      minVotes: 3,
      voiceShare: 0,
      targetCooldownMinutes: 0,
      failedCooldownMinutes: 0,
      starterCooldownMinutes: 0,
      ...patch,
    });
  });
}

/** The poll message currently in the text channel. */
const pollMessage = () => t.messenger.inChannel(channel)[0]!;
const pollId = () => parseCrazyVoteId(pollMessage().msg.buttons?.[0]?.customId ?? '')!;
const dms = () => t.mod.callsTo('dm').map((call) => call.args[1] as string);

/** Run a poll on `target` to a pass with a, b and c. */
async function passPoll() {
  await svc().invoke(a.userId, target.userId, channel);
  await svc().invoke(b.userId, target.userId, channel);
  await svc().invoke(c.userId, target.userId, channel);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-06-01T12:00:00Z'));
  t = testContainer();
  channel = t.guild.addChannel('general', 'text');
  vc = t.voice.addVoiceChannel('Hangout');
  target = t.guild.addMember();
  a = t.guild.addMember();
  b = t.guild.addMember();
  c = t.guild.addMember();
  configure();
});
afterEach(() => {
  svc().stop();
  t.close();
  vi.useRealTimers();
});

describe('starting and voting', () => {
  it('is off by default', async () => {
    t.services.settings.update(ADMIN, 'test', (s) => {
      s.thatsCrazy.enabled = false;
    });
    await expect(svc().invoke(a.userId, target.userId, channel)).rejects.toThrow(/turned off/);
  });

  it('posts a poll with a vote button, and later /thatscrazy calls add votes', async () => {
    expect(await svc().invoke(a.userId, target.userId, channel)).toMatch(/3 votes needed/);
    const msg = pollMessage().msg;
    expect(msg.buttons?.[0]?.customId).toBe(`${CRAZY_VOTE_PREFIX}${pollId()}`);
    expect(msg.embed?.fields?.[0]?.value).toBe('1 / 3');

    expect(await svc().invoke(b.userId, target.userId, channel)).toMatch(/Vote counted \(2 \/ 3\)/);
    expect(t.messenger.inChannel(channel)).toHaveLength(1);
    expect(pollMessage().msg.embed?.fields?.[0]?.value).toBe('2 / 3');
  });

  it('counts button votes once and never from the target', async () => {
    await svc().invoke(a.userId, target.userId, channel);
    expect(await svc().vote(pollId(), b.userId)).toMatch(/2 \/ 3/);
    expect(await svc().vote(pollId(), b.userId)).toBe('You already voted.');
    expect(await svc().vote(pollId(), a.userId)).toBe('You already voted.');
    await expect(svc().vote(pollId(), target.userId)).rejects.toThrow(/own poll/);
    await expect(svc().invoke(target.userId, target.userId, channel)).rejects.toThrow(/own poll/);
  });

  it('refuses self, bots, the owner, exempt roles and the dashboard', async () => {
    const bot = t.guild.addMember({ isBot: true });
    const owner = t.guild.addMember({ userId: OWNER_ID });
    const vip = t.guild.addMember({ roleIds: ['300000000000000001'] });
    configure({ exemptRoleIds: ['300000000000000001'] });
    await expect(svc().invoke(a.userId, a.userId, channel)).rejects.toThrow(/yourself/);
    await expect(svc().invoke(a.userId, bot.userId, channel)).rejects.toThrow(/Bots/);
    await expect(svc().invoke(a.userId, owner.userId, channel)).rejects.toThrow(/owner/);
    await expect(svc().invoke(a.userId, vip.userId, channel)).rejects.toThrow(/exempt/);
    await expect(svc().invoke(a.userId, target.userId, undefined)).rejects.toThrow(/Discord channel/);
  });

  it('scales the votes needed with the target voice channel', async () => {
    configure({ minVotes: 2, voiceShare: 0.5 });
    t.voice.states.set(target.userId, vc);
    for (let i = 0; i < 7; i++) t.voice.states.set(t.guild.addMember().userId, vc);
    // 7 others in voice: ceil(3.5) = 4 > minVotes.
    expect(await svc().invoke(a.userId, target.userId, channel)).toMatch(/4 votes needed/);
  });

  it('fails the poll when time runs out', async () => {
    await svc().invoke(a.userId, target.userId, channel);
    await vi.advanceTimersByTimeAsync(121_000);
    const msg = pollMessage().msg;
    expect(msg.embed?.title).toBe('Not crazy enough');
    expect(msg.buttons).toEqual([]);
    expect(await svc().vote(pollId() || 1, b.userId)).toBe('This poll is already closed.');
  });

  it('tick closes polls left open by a restart', async () => {
    await svc().invoke(a.userId, target.userId, channel);
    svc().stop(); // the timer is gone, as after a restart
    vi.setSystemTime(Date.now() + 5 * MIN);
    expect(await svc().tick()).toBe(1);
    expect(pollMessage().msg.embed?.title).toBe('Not crazy enough');
  });
});

describe('penalties', () => {
  it('mutes a target in voice right away, DMs them, then unmutes when it ends', async () => {
    t.voice.states.set(target.userId, vc);
    await passPoll();
    expect(t.voice.serverMuted.has(target.userId)).toBe(true);
    expect(pollMessage().msg.embed?.description).toMatch(/muted for 1 min\*\* \(strike 1\)/);
    expect(dms()).toEqual(["That's crazy. The people of Test Server voted, and you're muted for 1 min."]);

    vi.setSystemTime(Date.now() + MIN);
    await svc().tick();
    expect(t.voice.serverMuted.has(target.userId)).toBe(false);
    expect(svc().strikes(target.userId).active).toEqual([]);
  });

  it('waits for a target outside voice to join, and lifts on the next join if they left', async () => {
    await passPoll();
    expect(pollMessage().msg.embed?.description).toMatch(/starts when they join voice/);
    expect(svc().strikes(target.userId).active[0]).toMatchObject({ action: 'mute', waiting: true });

    t.voice.states.set(target.userId, vc);
    await svc().onVoiceJoin(target.userId);
    expect(t.voice.serverMuted.has(target.userId)).toBe(true);

    t.voice.states.delete(target.userId);
    vi.setSystemTime(Date.now() + 2 * MIN);
    await svc().tick(); // not in voice: Discord can't unmute yet
    t.voice.states.set(target.userId, vc);
    await svc().onVoiceJoin(target.userId);
    expect(t.voice.serverMuted.has(target.userId)).toBe(false);
  });

  it('drops a waiting penalty that ran out before they joined', async () => {
    await passPoll();
    vi.setSystemTime(Date.now() + 2 * MIN);
    await svc().tick();
    t.voice.states.set(target.userId, vc);
    await svc().onVoiceJoin(target.userId);
    expect(t.voice.serverMuted.has(target.userId)).toBe(false);
  });

  it('applies a waiting penalty from tick when the join event was missed', async () => {
    await passPoll();
    t.voice.states.set(target.userId, vc);
    await svc().tick();
    expect(t.voice.serverMuted.has(target.userId)).toBe(true);
  });

  it('disconnects again on every join until a disconnect penalty ends', async () => {
    configure({ ladder: [{ action: 'disconnect', minutes: 10 }] });
    t.voice.states.set(target.userId, vc);
    await passPoll();
    expect(t.voice.states.has(target.userId)).toBe(false);

    t.voice.states.set(target.userId, vc);
    await svc().onVoiceJoin(target.userId);
    expect(t.voice.states.has(target.userId)).toBe(false);

    vi.setSystemTime(Date.now() + 10 * MIN);
    t.voice.states.set(target.userId, vc);
    await svc().onVoiceJoin(target.userId);
    expect(t.voice.states.get(target.userId)).toBe(vc);
  });

  it('uses a Discord timeout even when the target is not in voice', async () => {
    configure({ ladder: [{ action: 'timeout', minutes: 30 }] });
    await passPoll();
    expect(t.mod.callsTo('timeout')[0]?.args.slice(0, 2)).toEqual([target.userId, 30 * MIN]);
  });

  it('reports a penalty Discord refused in the verdict', async () => {
    configure({ ladder: [{ action: 'disconnect', minutes: 5 }] });
    t.voice.states.set(target.userId, vc);
    t.voice.failMove = true;
    await passPoll();
    expect(pollMessage().msg.embed?.description).toMatch(/couldn't apply it/);
  });

  it('escalates along the ladder, picks the DM by strike, and forgets old strikes', async () => {
    configure({
      ladder: [
        { action: 'mute', minutes: 1 },
        { action: 'deafen', minutes: 5 },
      ],
      dmMessages: ['first {count}', 'again {count}: {action} {minutes}'],
      strikeWindowDays: 7,
    });
    t.voice.states.set(target.userId, vc);
    await passPoll();
    vi.setSystemTime(Date.now() + 10 * MIN);
    await passPoll();
    vi.setSystemTime(Date.now() + 10 * MIN);
    await passPoll();
    expect(t.voice.serverDeafened.has(target.userId)).toBe(true);
    expect(dms()).toEqual(['first 1', 'again 2: deafened 5', 'again 3: deafened 5']);
    expect(svc().strikes(target.userId).strikes).toBe(3);

    vi.setSystemTime(Date.now() + 8 * 86_400_000);
    expect(svc().strikes(target.userId).strikes).toBe(0);
    await passPoll();
    expect(dms().at(-1)).toBe('first 1');
  });

  it('keeps a mute in place while a newer mute is still running', async () => {
    configure({
      ladder: [
        { action: 'mute', minutes: 1 },
        { action: 'mute', minutes: 10 },
      ],
    });
    t.voice.states.set(target.userId, vc);
    await passPoll();
    await passPoll();
    vi.setSystemTime(Date.now() + 2 * MIN);
    await svc().tick();
    expect(t.voice.serverMuted.has(target.userId)).toBe(true);
    vi.setSystemTime(Date.now() + 10 * MIN);
    await svc().tick();
    expect(t.voice.serverMuted.has(target.userId)).toBe(false);
  });
});

describe('abuse limits', () => {
  it('cools a target down after a passed or failed poll', async () => {
    configure({ targetCooldownMinutes: 15, failedCooldownMinutes: 5 });
    await passPoll();
    const other = t.guild.addMember();
    await expect(svc().invoke(other.userId, target.userId, channel)).rejects.toThrow(/Give them a break/);
    vi.setSystemTime(Date.now() + 15 * MIN);
    await svc().invoke(other.userId, target.userId, channel);
    await vi.advanceTimersByTimeAsync(121_000); // fails
    await expect(svc().invoke(a.userId, target.userId, channel)).rejects.toThrow(/Give them a break/);
    vi.setSystemTime(Date.now() + 5 * MIN);
    await expect(svc().invoke(a.userId, target.userId, channel)).resolves.toMatch(/Poll started/);
  });

  it('limits how often one member starts polls', async () => {
    configure({ starterCooldownMinutes: 5 });
    await svc().invoke(a.userId, target.userId, channel);
    await expect(svc().invoke(a.userId, b.userId, channel)).rejects.toThrow(/started one recently/);
    // Voting on someone else's poll is still fine.
    await svc().invoke(c.userId, b.userId, channel);
    await expect(svc().invoke(a.userId, b.userId, channel)).resolves.toMatch(/Vote counted/);
  });
});

describe('admin', () => {
  it('reset clears strikes, lifts penalties and is audited', async () => {
    configure({ ladder: [{ action: 'mute', minutes: 60 }] });
    t.voice.states.set(target.userId, vc);
    await passPoll();
    expect(await svc().reset(ADMIN, target.userId)).toBe(1);
    expect(t.voice.serverMuted.has(target.userId)).toBe(false);
    expect(svc().strikes(target.userId)).toMatchObject({ strikes: 0, active: [] });
    expect(svc().strikes(target.userId).history[0]?.pardoned).toBe(true);
    expect(
      t.db
        .select()
        .from(auditLog)
        .all()
        .some((r) => r.action === 'thatsCrazy.reset'),
    ).toBe(true);
  });

  it('reset clears a running timeout', async () => {
    configure({ ladder: [{ action: 'timeout', minutes: 30 }] });
    await passPoll();
    await svc().reset(ADMIN, target.userId);
    expect(t.mod.callsTo('timeout').at(-1)?.args.slice(0, 2)).toEqual([target.userId, null]);
  });

  it('/thatscrazy and /crazy strikes run through the executor', async () => {
    const thatscrazy = t.services.registry.find('thatscrazy')!;
    const res = await t.executor.run({
      command: thatscrazy,
      actor: makeActor(a),
      source: 'slash',
      rawInput: { user: target.userId },
      channelId: channel,
    });
    expect(res.result).toMatchObject({ ok: true });
    expect(t.messenger.inChannel(channel)).toHaveLength(1);

    const owner = t.guild.addMember({ userId: OWNER_ID });
    const strikes = await t.executor.run({
      command: t.services.registry.find('crazy strikes')!,
      actor: makeActor(owner),
      source: 'slash',
      rawInput: { user: target.userId },
    });
    expect(strikes.result.embeds?.[0]?.description).toMatch(/\*\*0\*\* strikes/);
  });
});
