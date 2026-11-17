import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VoiceChannelSnapshot } from '../src/discord/ports.js';
import { VOICE_SESSION_GAP_MS } from '../src/services/activity.js';
import { OWNER_ID, testContainer } from './helpers.js';

const NOW = new Date('2026-06-01T12:00:00Z');
const ADMIN = { id: OWNER_ID, source: 'slash' as const };
const MIN = 60_000;

let t: ReturnType<typeof testContainer>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  t = testContainer();
});
afterEach(() => {
  t.services.tiers.stop();
  t.close();
  vi.useRealTimers();
});

const configure = (fn: (a: ReturnType<typeof t.services.settings.get>['activity']) => void) =>
  t.services.settings.update(ADMIN, 'test', (s) => fn(s.activity));

describe('long voice sessions', () => {
  const snap: VoiceChannelSnapshot[] = [
    {
      channelId: 'vc',
      members: [
        { userId: 'a', isBot: false, selfDeaf: false },
        { userId: 'b', isBot: false, selfDeaf: false },
      ],
    },
  ];
  const tick = (n: number) => {
    for (let i = 0; i < n; i++) {
      t.services.activity.voiceTick(snap, null);
      vi.advanceTimersByTime(MIN);
    }
  };

  it('scores minutes past the threshold with the multiplier', () => {
    configure((a) => {
      a.voiceLongSessionMinutes = 2;
      a.voiceLongSessionMultiplier = 0.5;
    });
    tick(4);
    const totals = t.services.activity.totals('a');
    expect(totals.voiceMinutes).toBe(4);
    expect(totals.voiceLongMinutes).toBe(2);
    // 2 × 0.2 + 2 × 0.2 × 0.5
    expect(totals.score).toBeCloseTo(0.6);
  });

  it('re-scores history when the multiplier changes, including above 1', () => {
    configure((a) => {
      a.voiceLongSessionMinutes = 2;
    });
    tick(4);
    expect(t.services.activity.totals('a').score).toBeCloseTo(0.8);
    configure((a) => {
      a.voiceLongSessionMultiplier = 2;
    });
    // 2 × 0.2 + 2 × 0.2 × 2
    expect(t.services.activity.totals('a').score).toBeCloseTo(1.2);
  });

  it('keeps the session through short gaps and restarts it after a long one', () => {
    configure((a) => {
      a.voiceLongSessionMinutes = 2;
    });
    tick(2);
    vi.advanceTimersByTime(2 * MIN);
    tick(1);
    expect(t.services.activity.totals('a').voiceLongMinutes).toBe(1);
    vi.advanceTimersByTime(VOICE_SESSION_GAP_MS + MIN);
    tick(2);
    expect(t.services.activity.totals('a').voiceLongMinutes).toBe(1);
  });
});

describe('reactions received', () => {
  const posted = NOW.getTime();
  const react = (reactorId: string, messageId = 'm1', authorId: string | null = 'author') =>
    t.services.activity.recordReaction({ reactorId, authorId, messageId, messageCreatedAt: posted });

  it('awards the author once per reactor within the window', () => {
    expect(react('r1')).toEqual({ given: true, received: true });
    expect(react('r1').received).toBe(false);
    expect(react('r2').received).toBe(true);
    const totals = t.services.activity.totals('author');
    expect(totals.reactionsReceived).toBe(2);
    expect(totals.score).toBeCloseTo(0.5);
  });

  it('ignores reactions after the window', () => {
    vi.advanceTimersByTime(5 * MIN + 1);
    expect(react('r1')).toEqual({ given: true, received: false });
    expect(t.services.activity.totals('author').reactionsReceived).toBe(0);
  });

  it('still counts each reactor once after the window is shrunk and widened again', () => {
    expect(react('r1').received).toBe(true);
    configure((a) => {
      a.reactionReceiveWindowMinutes = 1;
    });
    vi.advanceTimersByTime(2 * MIN);
    react('r2');
    configure((a) => {
      a.reactionReceiveWindowMinutes = 10;
    });
    expect(react('r1').received).toBe(false);
  });

  it('gives nothing for reacting to your own message', () => {
    expect(react('author')).toEqual({ given: false, received: false });
    expect(t.services.activity.totals('author').score).toBe(0);
  });

  it('awards nothing received when the author is a bot or webhook', () => {
    expect(react('r1', 'm1', null)).toEqual({ given: true, received: false });
  });

  it('starts a grace period with no reaction points after too many received', () => {
    configure((a) => {
      a.reactionGraceThreshold = 3;
      a.reactionGraceMinutes = 60;
    });
    for (const r of ['r1', 'r2', 'r3']) expect(react(r).received).toBe(true);
    expect(t.services.activity.reactionGraceUntil('author')).toBe(posted + 60 * MIN);
    expect(react('r4').received).toBe(false);
    // The author can't earn by giving reactions either.
    expect(
      t.services.activity.recordReaction({
        reactorId: 'author',
        authorId: 'r1',
        messageId: 'm2',
        messageCreatedAt: posted,
      }).given,
    ).toBe(false);
    expect(t.services.activity.totals('author').reactionsReceived).toBe(3);

    vi.advanceTimersByTime(60 * MIN);
    expect(t.services.activity.reactionGraceUntil('author')).toBeNull();
    t.services.activity.recordReaction({
      reactorId: 'r5',
      authorId: 'author',
      messageId: 'm3',
      messageCreatedAt: Date.now(),
    });
    expect(t.services.activity.totals('author').reactionsReceived).toBe(4);
  });

  it('only counts reactions inside the rolling grace window toward the threshold', () => {
    configure((a) => {
      a.reactionGraceThreshold = 2;
      a.reactionGraceWindowMinutes = 10;
      a.reactionReceiveWindowMinutes = 30;
    });
    react('r1');
    vi.advanceTimersByTime(11 * MIN);
    react('r2');
    expect(t.services.activity.reactionGraceUntil('author')).toBeNull();
    react('r3');
    expect(t.services.activity.reactionGraceUntil('author')).not.toBeNull();
  });

  it('never starts a grace period when the threshold is 0', () => {
    configure((a) => {
      a.reactionGraceThreshold = 0;
    });
    for (let i = 0; i < 50; i++) react(`r${i}`);
    expect(t.services.activity.reactionGraceUntil('author')).toBeNull();
    expect(t.services.activity.totals('author').reactionsReceived).toBe(50);
  });
});
