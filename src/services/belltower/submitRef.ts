import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * The `?ref=` on a member's personal link to Belltower's submit page. Belltower stores it with the
 * ticket and hands it back as `submitRef` (1.7.0+) without checking it, so Bernard signs it: only a
 * link Bernard gave someone can say which member sent a ticket.
 *
 *   bn1.<userId>.<channelId or 0>.<issued, unix seconds>.<signature>
 *
 * The signature is the first 16 bytes of an HMAC-SHA256 over the guild and those fields, base64url.
 * Every character is allowed by Belltower's ref pattern (letters, digits and `. _ ~ -`).
 */

const VERSION = 'bn1';
const SIG_BYTES = 16;
const SNOWFLAKE = /^\d{1,20}$/;

/** How long after a link is handed out a ticket sent with it still counts as that member's. */
export const REF_LIFETIME_MS = 24 * 60 * 60 * 1000;
/** Slack for Belltower's clock running behind Bernard's. */
const CLOCK_SKEW_MS = 5 * 60 * 1000;

export interface RefClaim {
  userId: string;
  /** Where the link was handed out: the fallback when the member's DMs are closed. */
  channelId: string | null;
  /** When the link was handed out (ms, rounded down to the second). */
  issuedAt: number;
}

/** A new signing key (stored per guild in bot_state). */
export function newRefKey(): string {
  return randomBytes(32).toString('hex');
}

function signature(key: string, guildId: string, userId: string, channel: string, issued: string): Buffer {
  return createHmac('sha256', Buffer.from(key, 'hex'))
    .update([VERSION, guildId, userId, channel, issued].join('|'))
    .digest()
    .subarray(0, SIG_BYTES);
}

export function signRef(key: string, guildId: string, claim: RefClaim): string {
  const channel = claim.channelId ?? '0';
  const issued = String(Math.floor(claim.issuedAt / 1000));
  const sig = signature(key, guildId, claim.userId, channel, issued).toString('base64url');
  return [VERSION, claim.userId, channel, issued, sig].join('.');
}

/**
 * The member a ref names, if Bernard signed it for this guild and the ticket was sent (`sentAt`, ms)
 * while the link was still good. Anything else, including garbage, is null.
 */
export function verifyRef(key: string, guildId: string, ref: string | null, sentAt: number): RefClaim | null {
  if (!ref) return null;
  const parts = ref.split('.');
  if (parts.length !== 5) return null;
  const [version, userId, channel, issued, sig] = parts as [string, string, string, string, string];
  if (
    version !== VERSION ||
    !SNOWFLAKE.test(userId) ||
    !SNOWFLAKE.test(channel) ||
    !/^\d{1,12}$/.test(issued)
  ) {
    return null;
  }
  // Compared as text: decoding base64url would let padding or stray characters through.
  const given = Buffer.from(sig);
  const expected = Buffer.from(signature(key, guildId, userId, channel, issued).toString('base64url'));
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  const issuedAt = Number(issued) * 1000;
  if (sentAt < issuedAt - CLOCK_SKEW_MS || sentAt > issuedAt + REF_LIFETIME_MS) return null;
  return { userId, channelId: channel === '0' ? null : channel, issuedAt };
}
