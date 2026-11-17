import { and, desc, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { issueReports } from '../../db/schema.js';
import type { GuildPort, MessengerPort, ModerationPort } from '../../discord/ports.js';
import type { Logger } from '../../logger.js';
import { COLORS } from '../../shared/commandResult.js';
import type { OutgoingMessage } from '../../shared/messages.js';
import type { AuditActor } from '../audit.js';
import type { BotStateStore } from '../botState.js';
import { UserError } from '../errors.js';
import type { LiveEvents } from '../liveEvents.js';
import type { SettingsService } from '../settings.js';
import type { StatusService } from '../status/service.js';
import { type BelltowerClient, BelltowerError, type NewCard, type TicketInfo } from './client.js';

const PANEL_KEY = 'belltower.panel';

/** Custom IDs of the panel's button and the modal it opens. */
export const REPORT_BUTTON_ID = 'bt:report';
export const REPORT_MODAL_ID = 'bt:report-modal';

export type ReportRow = typeof issueReports.$inferSelect;

export interface Reporter {
  userId: string;
  username: string;
  displayName: string;
}

export interface ReportInput {
  /** A Kuma monitor id (from autocomplete) or a free-text service name. */
  service: string;
  details?: string | null;
  /** Where the report was made. */
  channelId: string | null;
}

export interface BelltowerView {
  /** BELLTOWER_URL and BELLTOWER_TOKEN are set. */
  configured: boolean;
  /** Why the last check on Belltower failed, if it did. */
  error: string | null;
  errorSince: string | null;
  lastPollAt: string | null;
  panel: { channelId: string; messageId: string } | null;
}

export interface BelltowerDeps {
  db: Db;
  guildId: string;
  guild: GuildPort;
  mod: ModerationPort;
  messenger: MessengerPort;
  settings: SettingsService;
  state: BotStateStore;
  status: StatusService;
  /** null when BELLTOWER_URL / BELLTOWER_TOKEN aren't set. */
  client: BelltowerClient | null;
  logger: Logger;
  live?: LiveEvents;
  now?: () => number;
}

/** States after which a report is closed and its reporter told. */
const FINAL_STATES = new Set(['done', 'archived', 'deleted', 'missing']);

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();
/**
 * Member-supplied text echoed by the bot: no markdown, masked links or mentions. Links and
 * mentions need [ ] ( ) < >, so dropping those (with the formatting characters) defuses both.
 */
export const plain = (s: string) => s.replace(/[*_`~|>\\[\]()<#@]/g, '');

export function ticketLabel(row: { ticketNo: string | null; cardId: number }): string {
  return row.ticketNo ?? `#${row.cardId}`;
}

/**
 * Issue reports: members report a broken service from Discord, Bernard opens a Belltower ticket
 * (or adds to the open one for the same Uptime Kuma monitor), then watches it and tells each
 * reporter once it's done.
 */
export class BelltowerService {
  private error: string | null = null;
  private errorSince: number | null = null;
  private lastPollAt: number | null = null;
  private polling: Promise<number> | null = null;
  /** Members with a report on its way to Belltower; a second one waits for the cooldown. */
  private readonly inFlight = new Set<string>();
  private readonly now: () => number;

  constructor(private readonly d: BelltowerDeps) {
    this.now = d.now ?? Date.now;
  }

  configured(): boolean {
    return this.d.client !== null;
  }

  view(): BelltowerView {
    return {
      configured: this.configured(),
      error: this.error,
      errorSince: this.errorSince ? new Date(this.errorSince).toISOString() : null,
      lastPollAt: this.lastPollAt ? new Date(this.lastPollAt).toISOString() : null,
      panel: this.storedPanel(),
    };
  }

  private requireClient(): BelltowerClient {
    if (!this.d.client) throw new UserError("Reporting isn't set up on this server.");
    return this.d.client;
  }

  /** Check the connection (the dashboard's Test button and /belltower test). */
  async test(): Promise<void> {
    const client = this.requireClient();
    try {
      await client.ping();
      this.clearError();
    } catch (err) {
      this.setError(err);
      throw err instanceof BelltowerError ? new UserError(err.message) : err;
    } finally {
      this.d.live?.publish('belltower');
    }
  }

  /** Kuma monitors matching a query, for autocomplete. */
  serviceChoices(query: string): { name: string; value: string }[] {
    const q = query.trim().toLowerCase();
    return (this.d.status.view().snapshot?.monitors ?? [])
      .filter((m) => m.name.toLowerCase().includes(q))
      .slice(0, 25)
      .map((m) => ({ name: clip(m.name, 100), value: String(m.id) }));
  }

  private resolveService(input: string): { name: string; monitorId: number | null } {
    const raw = oneLine(input);
    const monitors = this.d.status.view().snapshot?.monitors ?? [];
    const lower = raw.toLowerCase();
    const m =
      monitors.find((x) => String(x.id) === raw) ?? monitors.find((x) => x.name.toLowerCase() === lower);
    return m ? { name: m.name, monitorId: m.id } : { name: raw, monitorId: null };
  }

  /** Why a member can't report right now, or null. Checked before the panel opens its form. */
  unavailableReason(): string | null {
    if (!this.d.client) return "Reporting isn't set up on this server.";
    if (!this.d.settings.get().belltower.enabled) {
      return 'Reports are paused right now. Please tell an admin directly.';
    }
    return null;
  }

  /** File a report. Returns the reply for the reporter. */
  async report(reporter: Reporter, input: ReportInput): Promise<string> {
    if (this.inFlight.has(reporter.userId)) throw new UserError('Your last report is still being sent.');
    this.inFlight.add(reporter.userId);
    try {
      return await this.fileReport(reporter, input);
    } finally {
      this.inFlight.delete(reporter.userId);
    }
  }

  private async fileReport(reporter: Reporter, input: ReportInput): Promise<string> {
    const client = this.requireClient();
    const cfg = this.d.settings.get().belltower;
    if (!cfg.enabled) throw new UserError('Reports are paused right now. Please tell an admin directly.');
    const service = this.resolveService(input.service);
    if (!service.name) throw new UserError("Say what isn't working.");

    if (cfg.cooldownSeconds > 0) {
      const last = this.d.db
        .select({ createdAt: issueReports.createdAt })
        .from(issueReports)
        .where(and(eq(issueReports.guildId, this.d.guildId), eq(issueReports.reporterId, reporter.userId)))
        .orderBy(desc(issueReports.createdAt))
        .limit(1)
        .get();
      const wait = last ? last.createdAt.getTime() + cfg.cooldownSeconds * 1000 - this.now() : 0;
      if (wait > 0) {
        throw new UserError(
          `You just sent a report. You can send another <t:${Math.ceil((this.now() + wait) / 1000)}:R>.`,
        );
      }
    }

    const details = input.details?.trim() ? input.details.trim().slice(0, 1500) : null;
    const channel = input.channelId ? this.d.guild.getChannel(input.channelId) : null;
    const lines = [
      `Reported in Discord by **${plain(reporter.displayName)}** (@${plain(reporter.username)})` +
        `${channel ? ` in #${plain(channel.name)}` : ''}.`,
      service.monitorId !== null ? `Service: ${service.name} (Uptime Kuma monitor ${service.monitorId})` : '',
      details ? `\n${details}` : '',
    ].filter(Boolean);
    const card: NewCard = {
      title: clip(details ? `${service.name}: ${oneLine(details)}` : `${service.name} isn't working`, 300),
      description: lines.join('\n'),
      ...(cfg.labels.length ? { labels: cfg.labels } : {}),
      ...(cfg.priority ? { priority: cfg.priority } : {}),
      ...(cfg.column ? { column: cfg.column } : {}),
      // Same key as Belltower's Uptime Kuma webhook: reports join the ticket Kuma opened, and Kuma
      // coming back up resolves it.
      ...(service.monitorId !== null ? { dedupeKey: `uptime-kuma:${service.monitorId}` } : {}),
    };

    let opened: Awaited<ReturnType<BelltowerClient['openCard']>>;
    try {
      opened = await client.openCard(card);
    } catch (err) {
      this.d.logger.warn({ err }, 'Could not open a Belltower ticket');
      throw new UserError("I couldn't file your report right now. Please tell an admin directly.");
    }

    const already = this.d.db
      .select({ id: issueReports.id })
      .from(issueReports)
      .where(
        and(
          eq(issueReports.guildId, this.d.guildId),
          eq(issueReports.reporterId, reporter.userId),
          eq(issueReports.cardId, opened.id),
          isNull(issueReports.closedAt),
        ),
      )
      .get();
    // A second report on the same open ticket still counts for the cooldown, but notifies once.
    this.d.db
      .insert(issueReports)
      .values({
        guildId: this.d.guildId,
        reporterId: reporter.userId,
        channelId: input.channelId,
        service: service.name.slice(0, 200),
        monitorId: service.monitorId,
        details,
        cardId: opened.id,
        ticketNo: opened.ticketNo,
        cardStatus: opened.status,
        createdAt: new Date(this.now()),
        ...(already
          ? { closedAt: new Date(this.now()), state: 'duplicate', notifiedVia: 'none' as const }
          : {}),
      })
      .run();
    this.d.live?.publish('belltower');

    const ticket = `**${ticketLabel({ ticketNo: opened.ticketNo, cardId: opened.id })}**`;
    const name = `**${plain(clip(service.name, 100))}**`;
    return opened.status === 'created'
      ? `Thanks! I opened ticket ${ticket} for ${name}. I'll message you when it's fixed.`
      : `Thanks! ${name} is already being looked at (ticket ${ticket}). I added your report to it and ` +
          "I'll message you when it's fixed.";
  }

  /** Check open reports and tell reporters about finished tickets. Returns how many were closed. */
  poll(): Promise<number> {
    if (this.polling) return this.polling;
    this.polling = this.doPoll().finally(() => {
      this.polling = null;
    });
    return this.polling;
  }

  private async doPoll(): Promise<number> {
    const client = this.d.client;
    if (!client) return 0;
    const open = this.d.db
      .select()
      .from(issueReports)
      .where(and(eq(issueReports.guildId, this.d.guildId), isNull(issueReports.closedAt)))
      .all();
    if (open.length === 0) {
      // Nothing to read, but don't leave an old error on the dashboard: check whether it's gone.
      if (this.error) {
        await client
          .ping()
          .then(() => this.clearError())
          .catch((err) => this.setError(err));
        this.d.live?.publish('belltower');
      }
      return 0;
    }

    let tickets: TicketInfo[];
    try {
      tickets = await client.getCards([...new Set(open.map((r) => r.cardId))]);
    } catch (err) {
      // Never close anything on a failed read: a missing answer isn't a missing ticket.
      this.setError(err);
      this.d.live?.publish('belltower');
      return 0;
    }
    this.clearError();
    this.lastPollAt = this.now();

    const byId = new Map(tickets.map((t) => [t.id, t]));
    let closed = 0;
    for (const row of open) {
      const t = byId.get(row.cardId);
      const state = !t
        ? 'missing'
        : t.deletedAt
          ? 'deleted'
          : t.state === 'done'
            ? 'done'
            : t.archivedAt
              ? 'archived'
              : t.state;
      const ticketNo = t?.ticketNo ?? row.ticketNo;
      const resolution = t?.resolution ?? null;
      if (!FINAL_STATES.has(state)) {
        if (state !== row.state || ticketNo !== row.ticketNo) {
          this.d.db.update(issueReports).set({ state, ticketNo }).where(eq(issueReports.id, row.id)).run();
        }
        continue;
      }
      // Close it first, unless it was dismissed meanwhile: only the update that closes it notifies.
      const claimed = this.d.db
        .update(issueReports)
        .set({ state, ticketNo, resolution, closedAt: new Date(this.now()) })
        .where(and(eq(issueReports.id, row.id), isNull(issueReports.closedAt)))
        .run();
      if (claimed.changes === 0) continue;
      const notifiedVia = await this.notify({ ...row, ticketNo }, state, resolution);
      this.d.db.update(issueReports).set({ notifiedVia }).where(eq(issueReports.id, row.id)).run();
      closed++;
    }
    this.d.live?.publish('belltower');
    return closed;
  }

  /** DM the reporter; if their DMs are closed, mention them where they reported. */
  private async notify(
    row: ReportRow,
    state: string,
    resolution: string | null,
  ): Promise<'dm' | 'channel' | 'none'> {
    const ticket = ticketLabel(row);
    const name = `**${plain(clip(row.service, 100))}**`;
    const text =
      state === 'done'
        ? `✅ Your report about ${name} (ticket ${ticket}) is resolved${resolution ? `: ${plain(resolution)}` : ''}.`
        : `ℹ️ Ticket ${ticket} for your report about ${name} was closed.`;
    if (await this.d.mod.dm(row.reporterId, text)) return 'dm';
    if (row.channelId) {
      try {
        const sent = await this.d.messenger.send(row.channelId, {
          content: `<@${row.reporterId}> ${text}`,
          mentionUserIds: [row.reporterId],
        });
        if (sent) return 'channel';
      } catch (err) {
        this.d.logger.warn({ err, channelId: row.channelId }, 'Could not post a report update');
      }
    }
    return 'none';
  }

  /** Open reports, and the latest closed ones. */
  list(recentLimit = 25): { open: ReportRow[]; recent: ReportRow[] } {
    const base = eq(issueReports.guildId, this.d.guildId);
    return {
      open: this.d.db
        .select()
        .from(issueReports)
        .where(and(base, isNull(issueReports.closedAt)))
        .orderBy(desc(issueReports.createdAt))
        .all(),
      recent: this.d.db
        .select()
        .from(issueReports)
        .where(and(base, isNotNull(issueReports.closedAt)))
        .orderBy(desc(issueReports.closedAt))
        .limit(recentLimit)
        .all(),
    };
  }

  /** Stop watching reports (they won't be notified). Used by the dashboard. */
  dismiss(ids: number[]): number {
    if (ids.length === 0) return 0;
    const res = this.d.db
      .update(issueReports)
      .set({ closedAt: new Date(this.now()), state: 'dismissed', notifiedVia: 'none' })
      .where(
        and(
          eq(issueReports.guildId, this.d.guildId),
          inArray(issueReports.id, ids),
          isNull(issueReports.closedAt),
        ),
      )
      .run();
    this.d.live?.publish('belltower');
    return res.changes;
  }

  // ── The "Report an issue" panel ──

  renderPanel(): OutgoingMessage {
    return {
      embed: {
        title: 'Something not working?',
        description:
          'Press **Report an issue** and say what broke. It goes straight to the admins, ' +
          "and I'll message you when it's fixed.",
        color: COLORS.info,
      },
      buttons: [{ customId: REPORT_BUTTON_ID, label: 'Report an issue', emoji: '🛎️', style: 'primary' }],
    };
  }

  private storedPanel(): { channelId: string; messageId: string } | null {
    const raw = this.d.state.get(PANEL_KEY);
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

  /** Post the panel in a channel (moving it from where it was), or take it down with null. */
  async setPanelChannel(actor: AuditActor, channelId: string | null): Promise<BelltowerView> {
    if (channelId) {
      this.requireClient();
      const c = this.d.guild.getChannel(channelId);
      if (!c || (c.kind !== 'text' && c.kind !== 'announcement')) {
        throw new UserError('Pick a text or announcement channel for the report panel.');
      }
    }
    this.d.settings.update(actor, 'settings.belltower.panel', (draft) => {
      draft.belltower.panelChannelId = channelId;
    });
    await this.syncPanel();
    const view = this.view();
    if (channelId && view.panel?.channelId !== channelId) {
      throw new UserError(
        `I can't post in <#${channelId}>. Give me View Channel, Send Messages and Embed Links there.`,
      );
    }
    this.d.live?.publish('belltower');
    return view;
  }

  /** Make the posted panel match the settings: edit it, re-post it if it was deleted, or remove it. */
  async syncPanel(): Promise<void> {
    const channelId = this.configured() ? this.d.settings.get().belltower.panelChannelId : null;
    const stored = this.storedPanel();
    if (stored && stored.channelId !== channelId) {
      await this.d.messenger.delete(stored.channelId, stored.messageId).catch(() => {});
      this.d.state.set(PANEL_KEY, '');
    }
    if (!channelId) return;
    const msg = this.renderPanel();
    const current = stored?.channelId === channelId ? stored : null;
    if (current && (await this.d.messenger.edit(channelId, current.messageId, msg))) return;
    const messageId = await this.d.messenger.send(channelId, msg);
    if (!messageId) {
      this.d.logger.warn({ channelId }, 'Report panel channel is missing or the bot cannot post there');
      return;
    }
    this.d.state.set(PANEL_KEY, JSON.stringify({ channelId, messageId }));
  }

  private setError(err: unknown): void {
    const known = err instanceof BelltowerError;
    const message = known ? err.message : 'Unexpected error talking to Belltower.';
    if (message !== this.error) {
      if (known) this.d.logger.warn({ error: message }, 'Belltower check failed');
      else this.d.logger.error({ err }, 'Belltower check failed');
    }
    this.error = message;
    this.errorSince ??= this.now();
  }

  private clearError(): void {
    this.error = null;
    this.errorSince = null;
  }
}
