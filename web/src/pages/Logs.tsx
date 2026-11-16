import { useInfiniteQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import type { LogDto, LogListResponse, Mentions } from '../../../src/shared/api.js';
import { api, qs } from '../api.js';
import { PageHeader } from '../components/Layout.js';
import { RichText } from '../components/RichText.js';
import {
  Badge,
  type BadgeTone,
  Button,
  Card,
  EmptyState,
  ErrorBox,
  Field,
  Input,
  Select,
  Spinner,
} from '../components/ui.js';
import { dateTime, relativeTime } from '../format.js';

const TYPES: { value: string; tone: BadgeTone }[] = [
  { value: 'moderation', tone: 'red' },
  { value: 'members', tone: 'green' },
  { value: 'messages', tone: 'yellow' },
  { value: 'voice', tone: 'blue' },
  { value: 'server', tone: 'orange' },
  { value: 'commands', tone: 'gray' },
];
const toneOf = (t: string) => TYPES.find((x) => x.value === t)?.tone ?? 'gray';
const ID = /^\d{17,20}$/;

function LogRow({ log, mentions }: { log: LogDto; mentions: Mentions }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="border-b border-slate-800/60 py-2.5 last:border-0">
      <div className="flex flex-wrap items-start gap-x-3 gap-y-1">
        <span
          className="w-24 shrink-0 text-xs whitespace-nowrap text-slate-500"
          title={dateTime(log.createdAt)}
        >
          {relativeTime(log.createdAt)}
        </span>
        <Badge tone={toneOf(log.type)}>{log.type}</Badge>
        <span className="font-mono text-xs text-slate-500">{log.event}</span>
        <span className="min-w-0 flex-1 basis-full text-sm break-words text-slate-200 sm:basis-auto">
          <RichText text={log.summary} mentions={mentions} />
        </span>
        {log.data && (
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            className="text-xs text-indigo-300 hover:underline"
            aria-expanded={open}
          >
            {open ? 'Hide details' : 'Details'}
          </button>
        )}
      </div>
      {open && log.data && (
        <pre className="mt-2 max-h-80 overflow-auto rounded-md bg-slate-950 p-3 text-xs text-slate-300">
          {JSON.stringify(log.data, null, 2)}
        </pre>
      )}
    </li>
  );
}

export function LogsPage() {
  const [params, setParams] = useSearchParams();
  const filters = {
    type: params.get('type') ?? '',
    user: params.get('user') ?? '',
    q: params.get('q') ?? '',
    from: params.get('from') ?? '',
    to: params.get('to') ?? '',
  };
  const [search, setSearch] = useState(filters.q);
  const set = (k: keyof typeof filters, v: string) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    setParams(next, { replace: true });
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: debounce only reacts to typing
  useEffect(() => {
    const t = setTimeout(() => {
      if (search !== filters.q) set('q', search);
    }, 350);
    return () => clearTimeout(t);
  }, [search]);

  const q = useInfiniteQuery({
    queryKey: ['logs', filters],
    initialPageParam: undefined as number | undefined,
    queryFn: ({ pageParam }) =>
      api<LogListResponse>(
        `/logs${qs({
          type: filters.type,
          user: ID.test(filters.user) ? filters.user : undefined,
          q: filters.q,
          from: filters.from ? new Date(`${filters.from}T00:00:00`).toISOString() : undefined,
          to: filters.to ? new Date(`${filters.to}T23:59:59`).toISOString() : undefined,
          before: pageParam,
          limit: 100,
        })}`,
      ),
    getNextPageParam: (last) => last.nextBefore ?? undefined,
  });

  const items = q.data?.pages.flatMap((p) => p.items) ?? [];
  const mentions: Mentions = (q.data?.pages ?? []).reduce<Mentions>(
    (acc, p) => ({
      users: { ...acc.users, ...p.mentions.users },
      roles: { ...acc.roles, ...p.mentions.roles },
      channels: { ...acc.channels, ...p.mentions.channels },
    }),
    { users: {}, roles: {}, channels: {} },
  );

  return (
    <>
      <PageHeader
        title="Logs"
        subtitle="Stored log entries. Older entries are pruned after the retention period."
      />
      <Card className="mb-4">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <Field label="Type">
            <Select value={filters.type} onChange={(e) => set('type', e.target.value)}>
              <option value="">All types</option>
              {TYPES.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.value}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="User ID">
            <Input
              value={filters.user}
              onChange={(e) => set('user', e.target.value.trim())}
              placeholder="Any"
              inputMode="numeric"
            />
          </Field>
          <Field label="Search">
            <Input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Text in summary"
            />
          </Field>
          <Field label="From">
            <Input type="date" value={filters.from} onChange={(e) => set('from', e.target.value)} />
          </Field>
          <Field label="To">
            <Input type="date" value={filters.to} onChange={(e) => set('to', e.target.value)} />
          </Field>
        </div>
      </Card>
      <Card>
        {q.error ? (
          <ErrorBox error={q.error} onRetry={() => q.refetch()} />
        ) : q.isPending ? (
          <div className="flex justify-center py-10">
            <Spinner />
          </div>
        ) : items.length === 0 ? (
          <EmptyState>No log entries match.</EmptyState>
        ) : (
          <>
            <ul>
              {items.map((l) => (
                <LogRow key={l.id} log={l} mentions={mentions} />
              ))}
            </ul>
            {q.hasNextPage && (
              <div className="mt-4 text-center">
                <Button variant="secondary" loading={q.isFetchingNextPage} onClick={() => q.fetchNextPage()}>
                  Load more
                </Button>
              </div>
            )}
          </>
        )}
      </Card>
    </>
  );
}
