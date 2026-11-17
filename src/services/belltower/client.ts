import { z } from 'zod';

/**
 * Talks to Belltower's automation API (docs/API-V1.md in Belltower), version 1:
 *   POST /api/v1/cards       open a ticket, or add a note to the open one with the same dedupeKey
 *   GET  /api/v1/cards?ids=  read tickets (Belltower 1.6+, full tokens only)
 *   GET  /api/v1/cards?updatedSince=  tickets changed since a time, with where each came from (1.6.0)
 */

export type TicketState = 'received' | 'in_progress' | 'waiting' | 'done';

export interface NewCard {
  title: string;
  description?: string;
  labels?: string[];
  priority?: 'P0' | 'P1' | 'P2' | 'P3';
  column?: string;
  dedupeKey?: string;
}

export interface OpenedCard {
  /** created: a new ticket. updated: a note was added to the open ticket with the same key. */
  status: 'created' | 'updated';
  id: number;
  ticketNo: string | null;
  title: string;
}

export interface TicketInfo {
  id: number;
  ticketNo: string | null;
  title: string;
  state: TicketState;
  resolution: string | null;
  archivedAt: string | null;
  deletedAt: string | null;
}

export interface ListedTicket extends TicketInfo {
  createdAt: string;
  updatedAt: string;
  /** submit (the submit page), api, recurring or manual. */
  source: string;
  /** The name typed on the submit page, or null. */
  submitter: string | null;
}

export interface ChangedTickets {
  tickets: ListedTicket[];
  /** Belltower's time for the answer: the `since` of the next call. */
  generatedAt: string;
}

export interface BelltowerClient {
  openCard(card: NewCard): Promise<OpenedCard>;
  /** The tickets among `ids` that still exist and the token can see. */
  getCards(ids: number[]): Promise<TicketInfo[]>;
  /** Every ticket changed at or after `since` (ISO time), all pages. */
  listChanged(since: string): Promise<ChangedTickets>;
  /** Check the address, the token, and that Belltower can be read back (1.6+). */
  ping(): Promise<void>;
}

/** Thrown with a message that is safe to show on the dashboard and in Discord. */
export class BelltowerError extends Error {}

const cardRef = z.object({ id: z.number().int(), ticketNo: z.string().nullable(), title: z.string() });

const openSchema = z.object({
  status: z.enum(['created', 'updated', 'recovered', 'resolved', 'ignored']),
  card: cardRef.nullable(),
});

const ticketSchema = cardRef.extend({
  state: z.enum(['received', 'in_progress', 'waiting', 'done']),
  resolution: z.string().nullable(),
  archivedAt: z.string().nullable(),
  deletedAt: z.string().nullable(),
});

const listSchema = z.object({ cards: z.array(z.unknown()) });

const pageSchema = z.object({
  cards: z.array(z.unknown()),
  more: z.boolean(),
  next: z.string().nullable(),
  generatedAt: z.string(),
});

const listedSchema = ticketSchema.extend({
  createdAt: z.string(),
  updatedAt: z.string(),
  // Optional so an older Belltower gets a readable error instead of "not in the expected format".
  source: z.string().optional(),
  submitter: z.string().nullable().optional(),
});

/** Most pages one listChanged call reads (200 tickets each). */
export const MAX_PAGES = 500;

/** Most ids one GET /api/v1/cards call takes. */
export const IDS_PER_REQUEST = 100;

/** Build an API URL under the Belltower base URL (which may include a sub-path). */
export function belltowerUrl(baseUrl: string, path: string): string {
  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  return new URL(path, base).toString();
}

/** Turn an HTTP status from Belltower into a readable error. Exported for tests. */
export function describeStatus(status: number, kind: 'read' | 'write', retryAfter?: string | null): string {
  switch (status) {
    case 401:
      return 'Belltower rejected the token. Check BELLTOWER_TOKEN, and that its owner is still active.';
    case 403:
      return 'The Belltower token is read-only. Create a full token for Bernard.';
    case 404:
      return kind === 'read'
        ? 'Belltower is too old to report back on tickets. Update it to 1.6 or later.'
        : "Belltower's automation API wasn't found. Check BELLTOWER_URL points at Belltower itself.";
    case 413:
      return 'The report was too large for Belltower.';
    case 429:
      return `Belltower is rate limiting Bernard${retryAfter ? ` (retry in ${retryAfter}s)` : ''}.`;
    default:
      return `Belltower answered with HTTP ${status}.`;
  }
}

export class HttpBelltowerClient implements BelltowerClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly timeoutMs = 10_000,
  ) {}

  private async request(path: string, kind: 'read' | 'write', body?: unknown): Promise<unknown> {
    let res: Response;
    try {
      res = await fetch(belltowerUrl(this.baseUrl, path), {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${this.token}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      const reason =
        err instanceof Error && err.name === 'TimeoutError'
          ? 'timed out'
          : ((err as { cause?: { code?: string } }).cause?.code ?? 'connection failed');
      throw new BelltowerError(`Couldn't reach Belltower (${reason}).`);
    }
    if (!res.ok) {
      let message = describeStatus(res.status, kind, res.headers.get('retry-after'));
      if (res.status === 400) {
        const detail = await res
          .json()
          .then((j) => (j as { message?: unknown }).message)
          .catch(() => null);
        if (typeof detail === 'string') message = `Belltower didn't accept the report: ${detail}`;
      }
      throw new BelltowerError(message);
    }
    try {
      return await res.json();
    } catch {
      throw new BelltowerError("Belltower's response wasn't JSON. Check BELLTOWER_URL points at Belltower.");
    }
  }

  async openCard(card: NewCard): Promise<OpenedCard> {
    const parsed = openSchema.safeParse(await this.request('api/v1/cards', 'write', card));
    if (!parsed.success || !parsed.data.card) {
      throw new BelltowerError("Belltower's answer wasn't in the expected format.");
    }
    const { status, card: c } = parsed.data;
    return { status: status === 'created' ? 'created' : 'updated', ...c };
  }

  async getCards(ids: number[]): Promise<TicketInfo[]> {
    const out: TicketInfo[] = [];
    for (let i = 0; i < ids.length; i += IDS_PER_REQUEST) {
      const chunk = ids.slice(i, i + IDS_PER_REQUEST);
      const json = await this.request(`api/v1/cards?ids=${chunk.join(',')}`, 'read');
      out.push(...parseTickets(json));
    }
    return out;
  }

  async listChanged(since: string): Promise<ChangedTickets> {
    const tickets: ListedTicket[] = [];
    let path = `api/v1/cards?updatedSince=${encodeURIComponent(since)}`;
    for (let page = 0; page < MAX_PAGES; page++) {
      const answer = parseTicketPage(await this.request(path, 'read'));
      tickets.push(...answer.tickets);
      if (!answer.next) return { tickets, generatedAt: answer.generatedAt };
      path = `api/v1/cards?cursor=${encodeURIComponent(answer.next)}`;
    }
    throw new BelltowerError('Belltower sent more changed tickets than Bernard reads at once.');
  }

  async ping(): Promise<void> {
    parseTickets(await this.request('api/v1/cards?ids=1', 'read'));
  }
}

/** Parse one page of GET /api/v1/cards?updatedSince= / ?cursor=. Exported for tests. */
export function parseTicketPage(json: unknown): ChangedTickets & { next: string | null } {
  const page = pageSchema.safeParse(json);
  if (!page.success) throw new BelltowerError("Belltower's answer wasn't in the expected format.");
  const tickets = page.data.cards.map((raw): ListedTicket => {
    const t = listedSchema.safeParse(raw);
    if (!t.success) throw new BelltowerError("Belltower's answer wasn't in the expected format.");
    const { id, ticketNo, title, state, resolution, archivedAt, deletedAt, createdAt, updatedAt } = t.data;
    if (t.data.source === undefined) {
      throw new BelltowerError(
        "Belltower doesn't say where tickets came from. Update it to 1.6.0 or later to list submit-page tickets.",
      );
    }
    return {
      ...{ id, ticketNo, title, state, resolution, archivedAt, deletedAt, createdAt, updatedAt },
      source: t.data.source,
      submitter: t.data.submitter ?? null,
    };
  });
  return {
    tickets,
    next: page.data.more ? page.data.next : null,
    generatedAt: page.data.generatedAt,
  };
}

/**
 * Parse a GET /api/v1/cards answer. Any entry that doesn't fit fails the whole answer: a skipped
 * ticket would look deleted and close its reports early. Exported for tests.
 */
export function parseTickets(json: unknown): TicketInfo[] {
  const list = listSchema.safeParse(json);
  if (!list.success) throw new BelltowerError("Belltower's answer wasn't in the expected format.");
  return list.data.cards.map((raw) => {
    const t = ticketSchema.safeParse(raw);
    if (!t.success) throw new BelltowerError("Belltower's answer wasn't in the expected format.");
    const { id, ticketNo, title, state, resolution, archivedAt, deletedAt } = t.data;
    return { id, ticketNo, title, state, resolution, archivedAt, deletedAt };
  });
}
