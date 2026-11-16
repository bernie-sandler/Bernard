import { and, desc, eq, lt } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { auditLog } from '../db/schema.js';

export interface AuditActor {
  id: string;
  source: 'slash' | 'dashboard' | 'system';
}

export interface AuditEntry {
  action: string;
  target?: string | null;
  before?: unknown;
  after?: unknown;
}

/** Records every configuration change (any source) and every dashboard action. */
export class AuditService {
  constructor(
    private readonly db: Db,
    private readonly guildId: string,
  ) {}

  record(actor: AuditActor, entry: AuditEntry): void {
    this.db
      .insert(auditLog)
      .values({
        guildId: this.guildId,
        actorId: actor.id,
        source: actor.source,
        action: entry.action,
        target: entry.target ?? null,
        before: entry.before === undefined ? null : entry.before,
        after: entry.after === undefined ? null : entry.after,
        createdAt: new Date(),
      })
      .run();
  }

  list(opts: { limit?: number; beforeId?: number } = {}) {
    const where = opts.beforeId
      ? and(eq(auditLog.guildId, this.guildId), lt(auditLog.id, opts.beforeId))
      : eq(auditLog.guildId, this.guildId);
    return this.db
      .select()
      .from(auditLog)
      .where(where)
      .orderBy(desc(auditLog.id))
      .limit(Math.min(opts.limit ?? 50, 200))
      .all();
  }
}
