import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { botState } from '../db/schema.js';

/** Small key/value store for bot bookkeeping (command hash, last tier sync, backfill flag...). */
export class BotStateStore {
  constructor(
    private readonly db: Db,
    private readonly guildId: string,
  ) {}

  get(key: string): string | null {
    const row = this.db
      .select({ value: botState.value })
      .from(botState)
      .where(and(eq(botState.guildId, this.guildId), eq(botState.key, key)))
      .get();
    return row?.value ?? null;
  }

  set(key: string, value: string): void {
    const now = new Date();
    this.db
      .insert(botState)
      .values({ guildId: this.guildId, key, value, updatedAt: now })
      .onConflictDoUpdate({ target: [botState.guildId, botState.key], set: { value, updatedAt: now } })
      .run();
  }
}
