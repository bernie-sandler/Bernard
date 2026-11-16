/**
 * Map Discord API errors to messages a moderator can act on. Duck-typed (no discord.js import) so
 * services can use it too. See https://discord.com/developers/docs/topics/opcodes-and-status-codes
 */
const MESSAGES: Record<number, string> = {
  10003: 'That channel no longer exists.',
  10004: 'The bot is not in that server.',
  10007: 'That member is not in the server.',
  10008: 'That message no longer exists.',
  10011: 'That role no longer exists.',
  10013: 'That user does not exist.',
  10026: 'That user is not banned.',
  30005: 'This server has reached the maximum number of roles.',
  30013: 'This server has reached the maximum number of channels.',
  50001: "I can't see that channel (missing access).",
  50013: "I'm missing a Discord permission for that, or the target's role is above mine.",
  50034: 'Those messages are older than 14 days and cannot be bulk deleted.',
  50035: 'Discord rejected the request as invalid.',
};

export function describeDiscordError(err: unknown): string | null {
  if (typeof err !== 'object' || err === null) return null;
  const e = err as { code?: unknown; status?: unknown; name?: unknown };
  if (typeof e.code === 'number' && MESSAGES[e.code]) return MESSAGES[e.code]!;
  if (e.status === 429) return 'Discord is rate limiting this action. Try again in a moment.';
  if (typeof e.status === 'number' && e.status >= 500)
    return 'Discord is having problems right now. Try again shortly.';
  if (e.name === 'DiscordAPIError' || (typeof e.code === 'number' && typeof e.status === 'number')) {
    return 'Discord rejected that action.';
  }
  return null;
}
