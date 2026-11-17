import { z } from 'zod';

/**
 * Reads an Uptime Kuma status page through its public JSON API (no login or API key):
 *   GET /api/status-page/:slug            groups and monitors shown on the page
 *   GET /api/status-page/heartbeat/:slug  recent heartbeats and 24h uptime per monitor
 * Only monitors on the status page are visible, so the page decides what Discord sees.
 */

export type MonitorStatus = 'up' | 'down' | 'pending' | 'maintenance' | 'unknown';

export interface KumaMonitor {
  id: number;
  name: string;
  group: string;
  status: MonitorStatus;
  /** Response time of the latest heartbeat, in ms. */
  ping: number | null;
  /** Kuma's message for the latest heartbeat (e.g. "200 - OK" or the error). */
  message: string;
  /** ISO time of the latest heartbeat. */
  checkedAt: string | null;
  /** 0..1 over the last 24 hours. */
  uptime24h: number | null;
}

export interface KumaSnapshot {
  title: string;
  monitors: KumaMonitor[];
}

export interface KumaClient {
  fetchStatusPage(baseUrl: string, slug: string): Promise<KumaSnapshot>;
}

/** Thrown with a message that is safe to show on the dashboard and in Discord. */
export class KumaError extends Error {}

const pageSchema = z.object({
  config: z.object({ title: z.string().nullish() }).nullish(),
  publicGroupList: z.array(
    z.object({
      name: z.string().nullish(),
      monitorList: z.array(z.object({ id: z.number().int(), name: z.string() })).default([]),
    }),
  ),
});

const heartbeatSchema = z.object({
  heartbeatList: z.record(
    z.string(),
    z.array(
      z.object({
        status: z.number().int(),
        time: z.string(),
        msg: z.string().nullish(),
        ping: z.number().nullish(),
      }),
    ),
  ),
  uptimeList: z.record(z.string(), z.number()).default({}),
});

const STATUS_CODES: Record<number, MonitorStatus> = { 0: 'down', 1: 'up', 2: 'pending', 3: 'maintenance' };

/** Kuma stores heartbeat times as UTC "YYYY-MM-DD HH:mm:ss(.SSS)" without a zone. */
export function parseKumaTime(time: string): string | null {
  const iso = /[zZ]|[+-]\d\d:?\d\d$/.test(time) ? time : `${time.replace(' ', 'T')}Z`;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

/** Combine the two Kuma responses into one snapshot. Exported for tests. */
export function toSnapshot(pageJson: unknown, heartbeatJson: unknown): KumaSnapshot {
  const page = pageSchema.safeParse(pageJson);
  const beats = heartbeatSchema.safeParse(heartbeatJson);
  if (!page.success || !beats.success) {
    throw new KumaError("Uptime Kuma's response wasn't in the expected format. Is that a Kuma status page?");
  }
  const monitors: KumaMonitor[] = [];
  for (const group of page.data.publicGroupList) {
    for (const m of group.monitorList) {
      const list = beats.data.heartbeatList[String(m.id)] ?? [];
      const latest = list.at(-1);
      const uptime = beats.data.uptimeList[`${m.id}_24`];
      monitors.push({
        id: m.id,
        name: m.name,
        group: group.name?.trim() || 'Services',
        status: latest ? (STATUS_CODES[latest.status] ?? 'unknown') : 'unknown',
        ping: latest?.ping ?? null,
        message: latest?.msg ?? '',
        checkedAt: latest ? parseKumaTime(latest.time) : null,
        uptime24h: uptime ?? null,
      });
    }
  }
  return { title: page.data.config?.title?.trim() || 'Server status', monitors };
}

/** Build an API URL under the Kuma base URL (which may include a sub-path). */
export function kumaApiUrl(baseUrl: string, path: string): string {
  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  return new URL(path, base).toString();
}

export class HttpKumaClient implements KumaClient {
  constructor(private readonly timeoutMs = 10_000) {}

  private async getJson(url: string): Promise<unknown> {
    let res: Response;
    try {
      res = await fetch(url, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      const reason =
        err instanceof Error && err.name === 'TimeoutError'
          ? 'timed out'
          : ((err as { cause?: { code?: string } }).cause?.code ?? 'connection failed');
      throw new KumaError(`Couldn't reach Uptime Kuma (${reason}).`);
    }
    if (res.status === 404) throw new KumaError('Uptime Kuma has no status page with that slug.');
    if (!res.ok) throw new KumaError(`Uptime Kuma answered with HTTP ${res.status}.`);
    try {
      return await res.json();
    } catch {
      throw new KumaError("Uptime Kuma's response wasn't JSON. Check the URL points at Kuma itself.");
    }
  }

  async fetchStatusPage(baseUrl: string, slug: string): Promise<KumaSnapshot> {
    const s = encodeURIComponent(slug);
    const [page, beats] = await Promise.all([
      this.getJson(kumaApiUrl(baseUrl, `api/status-page/${s}`)),
      this.getJson(kumaApiUrl(baseUrl, `api/status-page/heartbeat/${s}`)),
    ]);
    return toSnapshot(page, beats);
  }
}
