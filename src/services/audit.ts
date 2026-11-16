import { and, desc, eq, like, lt, type SQL } from 'drizzle-orm';
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

  list(
    opts: {
      limit?: number;
      beforeId?: number;
      actorId?: string;
      actionPrefix?: string;
      source?: AuditActor['source'];
    } = {},
  ) {
    const where: SQL[] = [eq(auditLog.guildId, this.guildId)];
    if (opts.beforeId) where.push(lt(auditLog.id, opts.beforeId));
    if (opts.actorId) where.push(eq(auditLog.actorId, opts.actorId));
    if (opts.source) where.push(eq(auditLog.source, opts.source));
    // Prefix match (e.g. "tiers." or "settings."); LIKE wildcards in the input are dropped.
    if (opts.actionPrefix) where.push(like(auditLog.action, `${opts.actionPrefix.replace(/[%_\\]/g, '')}%`));
    return this.db
      .select()
      .from(auditLog)
      .where(and(...where))
      .orderBy(desc(auditLog.id))
      .limit(Math.min(opts.limit ?? 50, 200))
      .all();
  }
}
