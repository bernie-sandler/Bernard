import { eq } from 'drizzle-orm';
import { defaultSettings, type Settings, settingsSchema } from '../config/settings.js';
import type { Db } from '../db/client.js';
import { guildSettings } from '../db/schema.js';
import type { Logger } from '../logger.js';
import type { AuditActor, AuditService } from './audit.js';
import { UserError } from './errors.js';

type Listener = (next: Settings, prev: Settings) => void;

/** Loads, validates, caches and persists the guild settings blob. Every change is audited. */
export class SettingsService {
  private cache: Settings | null = null;
  private readonly listeners = new Set<Listener>();

  constructor(
    private readonly db: Db,
    private readonly guildId: string,
    private readonly audit: AuditService,
    private readonly logger: Logger,
  ) {}

  get(): Settings {
    if (this.cache) return this.cache;
    const row = this.db.select().from(guildSettings).where(eq(guildSettings.guildId, this.guildId)).get();
    if (!row) {
      this.cache = defaultSettings();
      return this.cache;
    }
    const parsed = settingsSchema.safeParse(row.data);
    if (parsed.success) {
      this.cache = parsed.data;
    } else {
      this.logger.error({ issues: parsed.error.issues }, 'Stored settings are invalid; using defaults');
      this.cache = defaultSettings();
    }
    return this.cache;
  }

  /**
   * Apply a change. `mutate` receives a deep copy it may edit in place.
   * `action` names the change for the audit log, e.g. "settings.logs.set".
   */
  update(actor: AuditActor, action: string, mutate: (draft: Settings) => void): Settings {
    const prev = this.get();
    const draft = structuredClone(prev);
    mutate(draft);
    const result = settingsSchema.safeParse(draft);
    if (!result.success) {
      const msg = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
      throw new UserError(`Invalid settings: ${msg}`);
    }
    const next = result.data;
    const now = new Date();
    this.db
      .insert(guildSettings)
      .values({ guildId: this.guildId, data: next, updatedAt: now })
      .onConflictDoUpdate({ target: guildSettings.guildId, set: { data: next, updatedAt: now } })
      .run();
    this.cache = next;
    const { before, after } = diff(prev, next);
    this.audit.record(actor, { action, before, after });
    for (const l of this.listeners) {
      try {
        l(next, prev);
      } catch (err) {
        this.logger.error({ err }, 'Settings listener failed');
      }
    }
    return next;
  }

  onChange(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

/** Shallow per-section diff so audit rows stay readable. */
function diff(prev: Settings, next: Settings): { before: Partial<Settings>; after: Partial<Settings> } {
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  for (const key of Object.keys(next) as (keyof Settings)[]) {
    if (JSON.stringify(prev[key]) !== JSON.stringify(next[key])) {
      before[key] = prev[key];
      after[key] = next[key];
    }
  }
  return { before: before as Partial<Settings>, after: after as Partial<Settings> };
}
