import type { GuildPort, MessengerPort } from '../../discord/ports.js';
import type { Logger } from '../../logger.js';
import { COLORS, type ResultEmbed } from '../../shared/commandResult.js';
import type { AuditActor } from '../audit.js';
import type { BotStateStore } from '../botState.js';
import { UserError } from '../errors.js';
import type { LiveEvents } from '../liveEvents.js';
import type { SettingsService } from '../settings.js';
import {
  type KumaClient,
  KumaError,
  type KumaMonitor,
  type KumaSnapshot,
  type MonitorStatus,
} from './kuma.js';

const MESSAGE_KEY = 'status.message';

const ICONS: Record<MonitorStatus, string> = {
  up: '🟢',
  down: '🔴',
  pending: '🟡',
  maintenance: '🔧',
  unknown: '⚪',
};

export interface StatusView {
  configured: boolean;
  snapshot: KumaSnapshot | null;
  /** When the last successful read from Kuma happened. */
  fetchedAt: string | null;
  /** Why the last read failed, if it did. */
  error: string | null;
  errorSince: string | null;
  /** Where the status embed currently lives. */
  message: { channelId: string; messageId: string } | null;
}

export interface StatusDeps {
  guild: GuildPort;
  messenger: MessengerPort;
  kuma: KumaClient;
  settings: SettingsService;
  state: BotStateStore;
  logger: Logger;
  live?: LiveEvents;
  now?: () => number;
}

/** Discord allows 6000 characters per embed in total; stay well clear of it. */
const EMBED_BUDGET = 5500;
/** Discord's limit for one field value. */
const FIELD_LIMIT = 1024;

const ts = (ms: number, style: 'R' | 'f' = 'R') => `<t:${Math.floor(ms / 1000)}:${style}>`;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function formatUptime(u: number | null): string | null {
  if (u === null) return null;
  const pct = u * 100;
  return `${pct >= 99.995 ? '100' : pct.toFixed(2)}%`;
}

function monitorLine(m: KumaMonitor): string {
  const bits = [`${ICONS[m.status]} **${clip(m.name, 100)}**`];
  if (m.status === 'up' && m.ping !== null) bits.push(`${Math.round(m.ping)} ms`);
  if (m.status === 'maintenance') bits.push('maintenance');
  const uptime = formatUptime(m.uptime24h);
  if (uptime) bits.push(`${uptime} (24h)`);
  return bits.join(' · ');
}

/** The pinned embed. Pure, so it is easy to test. */
export function buildStatusEmbed(
  snapshot: KumaSnapshot | null,
  opts: { error: string | null; errorSince: number | null; now: number },
): ResultEmbed {
  const monitors = snapshot?.monitors ?? [];
  const down = monitors.filter((m) => m.status === 'down');
  const degraded = monitors.filter((m) => m.status === 'pending' || m.status === 'maintenance');

  const lines: string[] = [];
  if (!snapshot) lines.push('No status yet.');
  else if (monitors.length === 0) lines.push('The status page has no monitors.');
  else if (down.length > 0) {
    // Name every down monitor up front, so the length limits below can never hide one.
    const names = down.map((m) => `**${clip(m.name, 100)}**`);
    lines.push(clip(`${names.join(', ')} ${down.length === 1 ? 'is' : 'are'} down.`, 1500));
  } else if (degraded.length > 0) lines.push('Some services need attention.');
  else lines.push('Everything is up.');
  if (opts.error) {
    lines.push(
      `⚠️ Can't reach Uptime Kuma${opts.errorSince ? ` since ${ts(opts.errorSince)}` : ''}: ${opts.error}`,
    );
    if (snapshot) lines.push('Showing the last known status.');
  }

  const title = clip(snapshot?.title ?? 'Server status', 256);
  const description = lines.join('\n');
  const groups = new Map<string, KumaMonitor[]>();
  for (const m of monitors) groups.set(m.group, [...(groups.get(m.group) ?? []), m]);

  // Whole lines only, within each field's and the embed's limits; the rest become "+N more".
  let used = title.length + description.length + 'Updated'.length;
  const fields: { name: string; value: string }[] = [];
  for (const [group, list] of groups) {
    if (fields.length >= 25) break;
    const name = clip(group, 256);
    const more = (n: number) => `+${n} more`;
    const room = Math.min(FIELD_LIMIT, EMBED_BUDGET - used - name.length) - more(list.length).length - 1;
    const shown: string[] = [];
    let len = 0;
    for (const m of list) {
      const line = monitorLine(m);
      if (len + line.length + 1 > room) break;
      shown.push(line);
      len += line.length + 1;
    }
    if (shown.length === 0) continue;
    const hidden = list.length - shown.length;
    const value = hidden > 0 ? [...shown, more(hidden)].join('\n') : shown.join('\n');
    fields.push({ name, value });
    used += name.length + value.length;
  }

  const color = opts.error
    ? COLORS.neutral
    : down.length > 0
      ? COLORS.danger
      : degraded.length > 0
        ? COLORS.warning
        : COLORS.success;

  return {
    title,
    description,
    color,
    fields,
    footer: 'Updated',
    timestamp: new Date(opts.now).toISOString(),
  };
}

/**
 * Keeps one pinned status embed in sync with an Uptime Kuma status page and posts "down" / "back up"
 * alerts, pinging the role configured for each monitor.
 */
export class StatusService {
  private snapshot: KumaSnapshot | null = null;
  private fetchedAt: number | null = null;
  private error: string | null = null;
  private errorSince: number | null = null;
  private lastRunAt = 0;
  private running: Promise<StatusView> | null = null;
  /** Bumped when the status page changes, so a read of the old page still in flight is thrown away. */
  private generation = 0;
  private runningGeneration = -1;
  /** Last up/down state per monitor, to detect transitions. Pending/maintenance don't change it. */
  private lastDefinite = new Map<number, { status: 'up' | 'down'; since: number }>();
  private baselined = false;
  private readonly now: () => number;

  constructor(private readonly d: StatusDeps) {
    this.now = d.now ?? Date.now;
    d.settings.onChange((next, prev) => {
      const a = next.status;
      const b = prev.status;
      if (a.kumaUrl !== b.kumaUrl || a.slug !== b.slug) {
        // A different status page: start over so nothing alerts on the switch.
        this.snapshot = null;
        this.fetchedAt = null;
        this.error = null;
        this.errorSince = null;
        this.lastDefinite.clear();
        this.baselined = false;
        this.generation++;
      }
      if (JSON.stringify(a) !== JSON.stringify(b)) this.lastRunAt = 0;
    });
  }

  configured(): boolean {
    const s = this.d.settings.get().status;
    return Boolean(s.kumaUrl && s.slug);
  }

  view(): StatusView {
    return {
      configured: this.configured(),
      snapshot: this.snapshot,
      fetchedAt: this.fetchedAt ? new Date(this.fetchedAt).toISOString() : null,
      error: this.error,
      errorSince: this.errorSince ? new Date(this.errorSince).toISOString() : null,
      message: this.storedMessage(),
    };
  }

  /** Read a status page without saving anything (the dashboard's "Test connection"). */
  async test(kumaUrl: string, slug: string): Promise<KumaSnapshot> {
    return this.d.kuma.fetchStatusPage(kumaUrl, slug);
  }

  /** Refresh when the configured interval has passed (the job runs every minute). */
  async maybeScheduledRefresh(): Promise<StatusView | null> {
    if (!this.configured()) return null;
    const intervalMs = this.d.settings.get().status.intervalSeconds * 1000;
    // Small slack so a 60s interval isn't skipped by a tick that fires a few ms early.
    if (this.now() - this.lastRunAt < intervalMs - 2000) return null;
    return this.refresh();
  }

  /**
   * Read Kuma, send alerts for changes, and update the embed. Concurrent calls share one run, unless
   * the status page changed since that run started: then a new run is queued after it.
   */
  refresh(): Promise<StatusView> {
    if (this.running && this.runningGeneration === this.generation) return this.running;
    const prior = this.running ?? Promise.resolve();
    const run: Promise<StatusView> = prior
      .catch(() => {})
      .then(() => this.doRefresh())
      .finally(() => {
        if (this.running === run) this.running = null;
      });
    this.running = run;
    this.runningGeneration = this.generation;
    return run;
  }

  private async doRefresh(): Promise<StatusView> {
    this.lastRunAt = this.now();
    const s = this.d.settings.get().status;
    if (!s.kumaUrl || !s.slug) {
      // Not (or no longer) configured: take down an embed left from before.
      await this.syncMessage().catch((err) =>
        this.d.logger.warn({ err }, 'Could not remove the status embed'),
      );
      return this.view();
    }

    const generation = this.generation;
    try {
      const snapshot = await this.d.kuma.fetchStatusPage(s.kumaUrl, s.slug);
      if (generation !== this.generation) return this.view(); // the page changed meanwhile
      this.snapshot = snapshot;
      this.fetchedAt = this.now();
      this.error = null;
      this.errorSince = null;
      await this.handleTransitions(snapshot);
    } catch (err) {
      if (generation !== this.generation) return this.view();
      this.error = err instanceof KumaError ? err.message : 'Unexpected error reading Uptime Kuma.';
      this.errorSince ??= this.now();
      if (!(err instanceof KumaError)) this.d.logger.error({ err }, 'Status refresh failed');
      else this.d.logger.warn({ error: this.error }, 'Uptime Kuma unreachable');
    }

    try {
      await this.syncMessage();
    } catch (err) {
      this.d.logger.warn({ err }, 'Could not update the status embed');
    }
    this.d.live?.publish('status');
    return this.view();
  }

  private async handleTransitions(snapshot: KumaSnapshot): Promise<void> {
    const now = this.now();
    const seen = new Set<number>();
    const changes: { monitor: KumaMonitor; from: { status: 'up' | 'down'; since: number } }[] = [];
    for (const m of snapshot.monitors) {
      seen.add(m.id);
      if (m.status !== 'up' && m.status !== 'down') continue;
      const prev = this.lastDefinite.get(m.id);
      if (prev?.status === m.status) continue;
      this.lastDefinite.set(m.id, { status: m.status, since: now });
      // Only alert for monitors we already knew about, and never on the first read after start-up.
      if (prev && this.baselined) changes.push({ monitor: m, from: prev });
    }
    for (const id of this.lastDefinite.keys()) if (!seen.has(id)) this.lastDefinite.delete(id);
    this.baselined = true;

    const s = this.d.settings.get().status;
    if (!s.alertChannelId) return;
    for (const { monitor, from } of changes) {
      const roleId = s.alertRoles[String(monitor.id)];
      const role = roleId && this.d.guild.getRole(roleId) ? roleId : null;
      const wentDown = monitor.status === 'down';
      const lasted = Math.max(0, Math.round((now - from.since) / 60_000));
      const description = wentDown
        ? monitor.message
          ? clip(monitor.message, 500)
          : 'Uptime Kuma reports it as down.'
        : `Back after ${lasted < 1 ? 'under a minute' : lasted === 1 ? '1 minute' : `${lasted} minutes`}.`;
      try {
        await this.d.messenger.send(s.alertChannelId, {
          ...(role ? { content: `<@&${role}>`, mentionRoleIds: [role] } : {}),
          embed: {
            title: `${ICONS[monitor.status]} ${clip(monitor.name, 200)} ${wentDown ? 'is down' : 'is back up'}`,
            description,
            color: wentDown ? COLORS.danger : COLORS.success,
            timestamp: new Date(now).toISOString(),
          },
        });
      } catch (err) {
        this.d.logger.warn({ err, monitor: monitor.name }, 'Could not post status alert');
      }
    }
  }

  private storedMessage(): { channelId: string; messageId: string } | null {
    const raw = this.d.state.get(MESSAGE_KEY);
    if (!raw) return null;
    try {
      const v = JSON.parse(raw) as { channelId?: unknown; messageId?: unknown };
      return typeof v.channelId === 'string' && typeof v.messageId === 'string'
        ? { channelId: v.channelId, messageId: v.messageId }
        : null;
    } catch {
      return null;
    }
  }

  private async syncMessage(): Promise<void> {
    const channelId = this.configured() ? this.d.settings.get().status.channelId : null;
    const stored = this.storedMessage();
    if (stored && stored.channelId !== channelId) {
      // The embed moved (or was turned off): remove the old one.
      await this.d.messenger.delete(stored.channelId, stored.messageId).catch(() => {});
      this.d.state.set(MESSAGE_KEY, '');
    }
    if (!channelId) return;

    const embed = buildStatusEmbed(this.snapshot, {
      error: this.error,
      errorSince: this.errorSince,
      now: this.now(),
    });
    const current = stored?.channelId === channelId ? stored : null;
    if (current && (await this.d.messenger.edit(channelId, current.messageId, { embed }))) return;

    const messageId = await this.d.messenger.send(channelId, { embed });
    if (!messageId) {
      this.d.logger.warn({ channelId }, 'Status channel is missing or the bot cannot post there');
      return;
    }
    this.d.state.set(MESSAGE_KEY, JSON.stringify({ channelId, messageId }));
    if (!(await this.d.messenger.pin(channelId, messageId))) {
      this.d.logger.warn({ channelId }, 'Could not pin the status embed (needs Pin Messages)');
    }
  }

  /** Point the embed at a channel (posting it there now), or turn it off with null. */
  async setChannel(actor: AuditActor, channelId: string | null): Promise<StatusView> {
    if (channelId) {
      if (!this.configured()) throw new UserError('Set the Uptime Kuma URL and status page slug first.');
      const c = this.d.guild.getChannel(channelId);
      if (!c || (c.kind !== 'text' && c.kind !== 'announcement')) {
        throw new UserError('Pick a text or announcement channel for the status embed.');
      }
    }
    this.d.settings.update(actor, 'settings.status.channel', (draft) => {
      draft.status.channelId = channelId;
    });
    await this.running?.catch(() => {}); // a run already in flight still uses the old channel
    const view = await this.refresh();
    if (channelId && view.message?.channelId !== channelId) {
      throw new UserError(
        `I can't post in <#${channelId}>. Give me View Channel, Send Messages and Embed Links there.`,
      );
    }
    return view;
  }

  /** Set or clear (null) the role pinged when a monitor goes down or comes back. */
  setAlertRole(actor: AuditActor, monitorId: number, roleId: string | null): void {
    if (roleId && !this.d.guild.getRole(roleId)) throw new UserError('That role no longer exists.');
    this.d.settings.update(actor, 'settings.status.alertRole', (draft) => {
      const key = String(monitorId);
      if (roleId) draft.status.alertRoles[key] = roleId;
      else delete draft.status.alertRoles[key];
    });
  }
}
