const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

export function relativeTime(iso: string | Date, now = Date.now()): string {
  const t = typeof iso === 'string' ? Date.parse(iso) : iso.getTime();
  const diff = (t - now) / 1000;
  const abs = Math.abs(diff);
  if (abs < 60) return rtf.format(Math.round(diff), 'second');
  if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), 'hour');
  if (abs < 86400 * 30) return rtf.format(Math.round(diff / 86400), 'day');
  if (abs < 86400 * 365) return rtf.format(Math.round(diff / (86400 * 30)), 'month');
  return rtf.format(Math.round(diff / (86400 * 365)), 'year');
}

export function dateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export function date(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString(undefined, { dateStyle: 'medium' });
}

export function duration(ms: number): string {
  const parts: string[] = [];
  let rest = Math.round(ms / 1000);
  for (const [unit, sec] of [
    ['d', 86400],
    ['h', 3600],
    ['m', 60],
    ['s', 1],
  ] as const) {
    if (rest >= sec) {
      parts.push(`${Math.floor(rest / sec)}${unit}`);
      rest %= sec;
    }
  }
  return parts.join(' ') || '0s';
}

export function uptime(sec: number): string {
  return sec < 60
    ? `${sec}s`
    : duration(sec * 1000)
        .split(' ')
        .slice(0, 2)
        .join(' ');
}

export const number = (n: number) => (Number.isInteger(n) ? n.toLocaleString() : n.toFixed(1));

export const roleColor = (c: number) => (c ? `#${c.toString(16).padStart(6, '0')}` : '#99aab5');
