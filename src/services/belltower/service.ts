import { and, desc, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { issueReports, submittedTickets } from '../../db/schema.js';
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
import {
  type BelltowerClient,
  BelltowerError,
  type ListedTicket,
  type NewCard,
  type TicketInfo,
} from './client.js';
import { newRefKey, signRef, verifyRef } from './submitRef.js';

const PANEL_KEY = 'belltower.panel';
/** Belltower's generatedAt from the last read of submit-page tickets: where the next read starts. */
const SUBMIT_SINCE_KEY = 'belltower.submitSince';
/** Signs the ref on members' personal submit page links (submitRef.ts). */
const REF_KEY = 'belltower.refKey';
const EPOCH = '1970-01-01T00:00:00.000Z';

/** Custom IDs of the panel's button and the modal it opens. */
export const REPORT_BUTTON_ID = 'bt:report';
export const REPORT_MODAL_ID = 'bt:report-modal';

export type ReportRow = typeof issueReports.$inferSelect;
export type SubmittedRow = typeof submittedTickets.$inferSelect;

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
  /** The report panel can be posted: the API is set up, or (link mode) the submit page link is. */
  panelReady: boolean;
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

/** A ticket's state for Bernard: Belltower's, or done / archived / deleted / missing. */
function stateOf(t: TicketInfo | undefined): string {
  if (!t) return 'missing';
  if (t.deletedAt) return 'deleted';
  if (t.state === 'done') return 'done';
  if (t.archivedAt) return 'archived';
  return t.state;
}

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

  /** Whether the panel can be posted with the current settings. */
  panelReady(): boolean {
    const cfg = this.d.settings.get().belltower;
    return cfg.mode === 'link' ? Boolean(cfg.submitUrl) : this.configured();
  }

  view(): BelltowerView {
    return {
      configured: this.configured(),
      panelReady: this.panelReady(),
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
    const cfg = this.d.settings.get().belltower;
    if (cfg.mode === 'link') return this.linkBlocked();
    if (!this.d.client) return "Reporting isn't set up on this server.";
    if (!cfg.enabled) return 'Reports are paused right now. Please tell an admin directly.';
    return null;
  }

  /** Link mode: why the request form can't be handed out, or null. */
  private linkBlocked(): string | null {
    const cfg = this.d.settings.get().belltower;
    if (!cfg.enabled) return 'Reports are paused right now. Please tell an admin directly.';
    if (!cfg.submitUrl) return "Reporting isn't set up on this server.";
    return null;
  }

  private refKey(): string {
    const stored = this.d.state.get(REF_KEY);
    if (stored && /^[0-9a-f]{64}$/.test(stored)) return stored;
    const key = newRefKey();
    this.d.state.set(REF_KEY, key);
    return key;
  }

  /**
   * The submit page link to give a member: their own, carrying a signed ref, when Bernard can read
   * tickets back (BELLTOWER_URL and BELLTOWER_TOKEN set); otherwise the shared link.
   */
  submitLink(userId: string, channelId: string | null): string | null {
    const url = this.d.settings.get().belltower.submitUrl;
    if (!url || !this.configured()) return url;
    try {
      const personal = new URL(url);
      const ref = signRef(this.refKey(), this.d.guildId, { userId, channelId, issuedAt: this.now() });
      personal.searchParams.set('ref', ref);
      return personal.toString();
    } catch {
      return url;
    }
  }

  /**
   * Link mode's answer to /report and the panel's button: the (personal) request form link, or why
   * there isn't one (`url` null).
   */
  linkPrompt(userId: string, channelId: string | null): { text: string; url: string | null } {
    const blocked = this.linkBlocked();
    const url = blocked ? null : this.submitLink(userId, channelId);
    if (!url) return { text: blocked ?? "Reporting isn't set up on this server.", url: null };
    return {
      text: this.configured()
        ? "It's your own link: I'll message you when your ticket is done. It works for a day, so " +
          "don't share it."
        : "You'll get a ticket number and a link to check on it there.",
      url,
    };
  }

  /** File a report. Returns the reply for the reporter. */
  async report(reporter: Reporter, input: ReportInput): Promise<string> {
    const cfg = this.d.settings.get().belltower;
    if (cfg.mode === 'link') {
      const { text, url } = this.linkPrompt(reporter.userId, input.channelId);
      if (!url) throw new UserError(text);
      return `Report it on the request form: ${url}\n${text}`;
    }
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
    let syncFailed = false;
    if (this.d.settings.get().belltower.mode === 'link') {
      try {
        if (await this.syncSubmissions(client)) this.d.live?.publish('belltower');
        this.clearError();
        this.lastPollAt = this.now();
      } catch (err) {
        // Keep following reports filed before the switch, but leave this error on the dashboard.
        this.setError(err);
        this.d.live?.publish('belltower');
        syncFailed = true;
      }
    }
    return this.pollReports(client, syncFailed);
  }

  /**
   * Link mode: read the tickets changed since the last read and keep the submit-page ones, then
   * re-check the open ones that didn't change, to catch tickets that vanished. Returns whether
   * anything changed here.
   */
  private async syncSubmissions(client: BelltowerClient): Promise<boolean> {
    const since = this.d.state.get(SUBMIT_SINCE_KEY) || EPOCH;
    const { tickets, generatedAt } = await client.listChanged(since);
    let changed = false;
    const seen = new Set<number>();
    for (const t of tickets) {
      if (t.source !== 'submit') continue;
      seen.add(t.id);
      if (this.storeSubmission(t, stateOf(t))) changed = true;
    }
    const stale = this.d.db
      .select({ cardId: submittedTickets.cardId })
      .from(submittedTickets)
      .where(and(eq(submittedTickets.guildId, this.d.guildId), isNull(submittedTickets.closedAt)))
      .all()
      .map((r) => r.cardId)
      .filter((id) => !seen.has(id));
    if (stale.length) {
      const found = new Set((await client.getCards(stale)).map((t) => t.id));
      for (const cardId of stale) {
        if (found.has(cardId)) continue;
        this.d.db
          .update(submittedTickets)
          .set({ state: 'missing', closedAt: new Date(this.now()) })
          .where(and(eq(submittedTickets.guildId, this.d.guildId), eq(submittedTickets.cardId, cardId)))
          .run();
        changed = true;
      }
    }
    this.d.state.set(SUBMIT_SINCE_KEY, generatedAt);
    if (await this.notifySubmitters()) changed = true;
    return changed;
  }

  /**
   * Insert or update one submit-page ticket. A valid signed ref names the member who sent it; once
   * it closes they're told (notifySubmitters), and again if it's reopened and closes again.
   * Returns whether the stored row changed.
   */
  private storeSubmission(t: ListedTicket, state: string): boolean {
    const base = and(eq(submittedTickets.guildId, this.d.guildId), eq(submittedTickets.cardId, t.id));
    const existing = this.d.db.select().from(submittedTickets).where(base).get();
    const final = FINAL_STATES.has(state);
    const parsed = Date.parse(t.createdAt);
    const created = Number.isNaN(parsed) ? this.now() : parsed;
    const who =
      t.submitRef && !existing?.submitterId
        ? verifyRef(this.refKey(), this.d.guildId, t.submitRef, created)
        : null;
    const values = {
      ticketNo: t.ticketNo,
      title: t.title.slice(0, 300),
      submitter: t.submitter?.slice(0, 100) ?? null,
      state,
      resolution: state === 'done' ? t.resolution : null,
      closedAt: final ? (existing?.closedAt ?? new Date(this.now())) : null,
      // Pending (null) until the closing is told; cleared again when it's reopened.
      notifiedVia: final && existing?.closedAt ? existing.notifiedVia : null,
      ...(who ? { submitterId: who.userId, channelId: who.channelId } : {}),
    };
    if (!existing) {
      this.d.db
        .insert(submittedTickets)
        .values({ guildId: this.d.guildId, cardId: t.id, createdAt: new Date(created), ...values })
        .run();
      return true;
    }
    const same =
      !who &&
      existing.ticketNo === values.ticketNo &&
      existing.title === values.title &&
      existing.submitter === values.submitter &&
      existing.state === values.state &&
      existing.resolution === values.resolution &&
      existing.notifiedVia === values.notifiedVia &&
      (existing.closedAt === null) === (values.closedAt === null);
    if (same) return false;
    this.d.db.update(submittedTickets).set(values).where(base).run();
    return true;
  }

  /** Tell members whose submit-page tickets closed and who haven't heard yet. Returns whether any were. */
  private async notifySubmitters(): Promise<boolean> {
    const pending = this.d.db
      .select()
      .from(submittedTickets)
      .where(
        and(
          eq(submittedTickets.guildId, this.d.guildId),
          isNotNull(submittedTickets.closedAt),
          isNotNull(submittedTickets.submitterId),
          isNull(submittedTickets.notifiedVia),
        ),
      )
      .all();
    for (const row of pending) {
      // Claim it first: only the update that claims it notifies.
      const claimed = this.d.db
        .update(submittedTickets)
        .set({ notifiedVia: 'none' })
        .where(and(eq(submittedTickets.id, row.id), isNull(submittedTickets.notifiedVia)))
        .run();
      if (claimed.changes === 0 || !row.submitterId) continue;
      const ticket = ticketLabel(row);
      const title = `**${plain(clip(oneLine(row.title), 100))}**`;
      const text =
        row.state === 'done'
          ? `✅ Your request ${title} (ticket ${ticket}) is resolved${row.resolution ? `: ${plain(row.resolution)}` : ''}.`
          : `ℹ️ Your request ${title} (ticket ${ticket}) was closed.`;
      const notifiedVia = await this.tell(row.submitterId, row.channelId, text);
      this.d.db.update(submittedTickets).set({ notifiedVia }).where(eq(submittedTickets.id, row.id)).run();
    }
    return pending.length > 0;
  }

  /** `keepError`: the submit-page read failed this round, so a working read here doesn't clear it. */
  private async pollReports(client: BelltowerClient, keepError = false): Promise<number> {
    const open = this.d.db
      .select()
      .from(issueReports)
      .where(and(eq(issueReports.guildId, this.d.guildId), isNull(issueReports.closedAt)))
      .all();
    if (open.length === 0) {
      // Nothing to read, but don't leave an old error on the dashboard: check whether it's gone.
      if (this.error && !keepError) {
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
    if (!keepError) {
      this.clearError();
      this.lastPollAt = this.now();
    }

    const byId = new Map(tickets.map((t) => [t.id, t]));
    let closed = 0;
    for (const row of open) {
      const t = byId.get(row.cardId);
      const state = stateOf(t);
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
    return this.tell(row.reporterId, row.channelId, text);
  }

  /** DM a member; if their DMs are closed, mention them in `channelId` instead. */
  private async tell(
    userId: string,
    channelId: string | null,
    text: string,
  ): Promise<'dm' | 'channel' | 'none'> {
    if (await this.d.mod.dm(userId, text)) return 'dm';
    if (channelId) {
      try {
        const sent = await this.d.messenger.send(channelId, {
          content: `<@${userId}> ${text}`,
          mentionUserIds: [userId],
        });
        if (sent) return 'channel';
      } catch (err) {
        this.d.logger.warn({ err, channelId }, 'Could not post a report update');
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

  /** Open submit-page tickets, and the latest closed ones (link mode's dashboard lists). */
  listSubmitted(recentLimit = 25): { open: SubmittedRow[]; recent: SubmittedRow[] } {
    const base = eq(submittedTickets.guildId, this.d.guildId);
    return {
      open: this.d.db
        .select()
        .from(submittedTickets)
        .where(and(base, isNull(submittedTickets.closedAt)))
        .orderBy(desc(submittedTickets.createdAt))
        .all(),
      recent: this.d.db
        .select()
        .from(submittedTickets)
        .where(and(base, isNotNull(submittedTickets.closedAt)))
        .orderBy(desc(submittedTickets.closedAt))
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
    const cfg = this.d.settings.get().belltower;
    if (cfg.mode === 'link') {
      if (!cfg.enabled || !cfg.submitUrl) {
        return {
          embed: {
            title: 'Something not working?',
            description: 'Reports are paused right now. Please tell an admin directly.',
            color: COLORS.info,
          },
        };
      }
      // With the API, the button hands each member their own link (a link button is the same for
      // everyone), so Bernard can tell them when their ticket is done.
      if (this.configured()) {
        return {
          embed: {
            title: 'Something not working?',
            description:
              'Press **Report an issue** to get your own link to the request form. ' +
              "I'll message you when your ticket is done.",
            color: COLORS.info,
          },
          buttons: [{ customId: REPORT_BUTTON_ID, label: 'Report an issue', emoji: '🛎️', style: 'primary' }],
        };
      }
      return {
        embed: {
          title: 'Something not working?',
          description:
            'Press **Report an issue** to open the request form. You get a ticket number and a link ' +
            'to check on it.',
          color: COLORS.info,
        },
        buttons: [{ url: cfg.submitUrl, label: 'Report an issue', emoji: '🛎️' }],
      };
    }
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
      if (!this.panelReady()) {
        throw new UserError(
          this.d.settings.get().belltower.mode === 'link'
            ? 'Set the submit page link first.'
            : "Reporting isn't set up on this server.",
        );
      }
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
    const channelId = this.panelReady() ? this.d.settings.get().belltower.panelChannelId : null;
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
