import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { and, eq, lt } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { sessions } from '../db/schema.js';

export type SessionRow = typeof sessions.$inferSelect;

const hash = (raw: string) => createHash('sha256').update(raw).digest('hex');
const token = () => randomBytes(32).toString('base64url');

/** Constant-time string comparison. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/**
 * Server-side dashboard sessions. Only a SHA-256 of the session id is stored, so a leaked database
 * can't be used to hijack sessions. Each session carries its own CSRF token.
 */
export class SessionService {
  constructor(
    private readonly db: Db,
    private readonly guildId: string,
    private readonly ttlMs: number,
  ) {}

  get ttlSeconds(): number {
    return Math.floor(this.ttlMs / 1000);
  }

  create(user: { userId: string; username: string; avatar: string | null }, now = Date.now()) {
    const rawId = token();
    const row = this.db
      .insert(sessions)
      .values({
        idHash: hash(rawId),
        guildId: this.guildId,
        userId: user.userId,
        csrfToken: token(),
        user: { username: user.username, avatar: user.avatar },
        createdAt: new Date(now),
        expiresAt: new Date(now + this.ttlMs),
      })
      .returning()
      .get();
    return { rawId, session: row };
  }

  get(rawId: string, now = Date.now()): SessionRow | null {
    const row = this.db
      .select()
      .from(sessions)
      .where(eq(sessions.idHash, hash(rawId)))
      .get();
    if (!row) return null;
    if (row.expiresAt.getTime() <= now) {
      this.destroy(rawId);
      return null;
    }
    return row;
  }

  /** Whether a session (by its stored hash) still exists and hasn't expired. */
  isActive(idHash: string, now = Date.now()): boolean {
    const row = this.db
      .select({ expiresAt: sessions.expiresAt })
      .from(sessions)
      .where(eq(sessions.idHash, idHash))
      .get();
    return Boolean(row && row.expiresAt.getTime() > now);
  }

  destroy(rawId: string): void {
    this.db
      .delete(sessions)
      .where(eq(sessions.idHash, hash(rawId)))
      .run();
  }

  destroyForUser(userId: string): number {
    return this.db
      .delete(sessions)
      .where(and(eq(sessions.guildId, this.guildId), eq(sessions.userId, userId)))
      .run().changes;
  }

  prune(now = Date.now()): number {
    return this.db
      .delete(sessions)
      .where(lt(sessions.expiresAt, new Date(now)))
      .run().changes;
  }
}
