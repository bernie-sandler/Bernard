import type { ApiError as ApiErrorBody } from '../../src/shared/api.js';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly node?: string,
  ) {
    super(message);
  }
}

let csrfToken: string | null = null;

export function setCsrfToken(token: string | null): void {
  csrfToken = token;
}

/** JSON fetch against /api with the session cookie and, for writes, the CSRF token. */
export async function api<T>(
  path: string,
  opts: { method?: 'GET' | 'POST'; body?: unknown } = {},
): Promise<T> {
  const method = opts.method ?? 'GET';
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (method !== 'GET') {
    headers['Content-Type'] = 'application/json';
    if (csrfToken) headers['X-CSRF-Token'] = csrfToken;
  }
  const res = await fetch(`/api${path}`, {
    method,
    headers,
    credentials: 'same-origin',
    ...(method !== 'GET' ? { body: JSON.stringify(opts.body ?? {}) } : {}),
  });
  if (!res.ok) {
    let body: Partial<ApiErrorBody> = {};
    try {
      body = (await res.json()) as ApiErrorBody;
    } catch {
      // non-JSON error
    }
    throw new ApiError(res.status, body.error ?? res.statusText, body.node);
  }
  return (await res.json()) as T;
}

/** Build a query string, skipping empty values. */
export function qs(params: Record<string, string | number | undefined | null>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : '';
}
