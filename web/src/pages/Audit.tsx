import { useInfiniteQuery } from '@tanstack/react-query';
import { Fragment, useState } from 'react';
import { useSearchParams } from 'react-router';
import type { AuditListResponse } from '../../../src/shared/api.js';
import { api, qs } from '../api.js';
import { PageHeader } from '../components/Layout.js';
import {
  Avatar,
  Badge,
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

const AREAS = [
  { value: '', label: 'Everything' },
  { value: 'permissions.', label: 'Permissions' },
  { value: 'settings.', label: 'Settings' },
  { value: 'tiers.', label: 'Tiers' },
  { value: 'voice.', label: 'Voice hubs' },
  { value: 'dashboard.', label: 'Dashboard actions' },
];
const ID = /^\d{17,20}$/;

function Json({ label, value }: { label: string; value: unknown }) {
  return (
    <div className="min-w-0">
      <div className="mb-1 text-xs font-semibold text-slate-500 uppercase">{label}</div>
      <pre className="max-h-72 overflow-auto rounded-md bg-slate-950 p-2 text-xs text-slate-300">
        {value === null || value === undefined ? '—' : JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
}

export function AuditPage() {
  const [params, setParams] = useSearchParams();
  const [open, setOpen] = useState<number | null>(null);
  const filters = {
    action: params.get('action') ?? '',
    source: params.get('source') ?? '',
    actor: params.get('actor') ?? '',
  };
  const set = (k: keyof typeof filters, v: string) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    setParams(next, { replace: true });
  };
  const q = useInfiniteQuery({
    queryKey: ['audit', filters],
    initialPageParam: undefined as number | undefined,
    queryFn: ({ pageParam }) =>
      api<AuditListResponse>(
        `/audit${qs({
          action: filters.action,
          source: filters.source,
          actor: ID.test(filters.actor) ? filters.actor : undefined,
          before: pageParam,
          limit: 50,
        })}`,
      ),
    getNextPageParam: (last) => last.nextBefore ?? undefined,
  });
  const items = q.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <>
      <PageHeader
        title="Audit log"
        subtitle="Every configuration change (from any source) and every dashboard action, with before and after values."
      />
      <Card className="mb-4">
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Area">
            <Select value={filters.action} onChange={(e) => set('action', e.target.value)}>
              {AREAS.map((a) => (
                <option key={a.value} value={a.value}>
                  {a.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Source">
            <Select value={filters.source} onChange={(e) => set('source', e.target.value)}>
              <option value="">Any</option>
              <option value="slash">Slash command</option>
              <option value="dashboard">Dashboard</option>
              <option value="system">System</option>
            </Select>
          </Field>
          <Field label="Actor user ID">
            <Input
              value={filters.actor}
              onChange={(e) => set('actor', e.target.value.trim())}
              placeholder="Anyone"
              inputMode="numeric"
            />
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
          <EmptyState>Nothing recorded yet.</EmptyState>
        ) : (
          <div className="-mx-4 overflow-x-auto sm:mx-0">
            <table className="w-full min-w-[720px] text-left text-sm">
              <thead className="text-xs text-slate-500 uppercase">
                <tr className="border-b border-slate-800">
                  <th className="px-3 py-2 font-medium">When</th>
                  <th className="px-3 py-2 font-medium">Who</th>
                  <th className="px-3 py-2 font-medium">Action</th>
                  <th className="px-3 py-2 font-medium">Target</th>
                  <th className="px-3 py-2 font-medium" />
                </tr>
              </thead>
              <tbody>
                {items.map((a) => (
                  <Fragment key={a.id}>
                    <tr className="border-b border-slate-800/60">
                      <td
                        className="px-3 py-2 whitespace-nowrap text-slate-400"
                        title={dateTime(a.createdAt)}
                      >
                        {relativeTime(a.createdAt)}
                      </td>
                      <td className="px-3 py-2">
                        <span className="flex items-center gap-2">
                          <Avatar url={a.actor.avatarUrl} name={a.actor.name} size={22} />
                          <span className="truncate">{a.actor.name}</span>
                          <Badge>{a.source}</Badge>
                        </span>
                      </td>
                      <td className="px-3 py-2 font-mono text-xs text-slate-200">{a.action}</td>
                      <td className="px-3 py-2 text-slate-300">{a.targetLabel ?? a.target ?? '—'}</td>
                      <td className="px-3 py-2 text-right">
                        {(a.before !== null || a.after !== null) && (
                          <button
                            type="button"
                            className="text-xs text-indigo-300 hover:underline"
                            aria-expanded={open === a.id}
                            onClick={() => setOpen(open === a.id ? null : a.id)}
                          >
                            {open === a.id ? 'Hide' : 'Changes'}
                          </button>
                        )}
                      </td>
                    </tr>
                    {open === a.id && (
                      <tr className="border-b border-slate-800/60">
                        <td colSpan={5} className="px-3 py-3">
                          <div className="grid gap-3 md:grid-cols-2">
                            <Json label="Before" value={a.before} />
                            <Json label="After" value={a.after} />
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {q.hasNextPage && (
          <div className="mt-4 text-center">
            <Button variant="secondary" loading={q.isFetchingNextPage} onClick={() => q.fetchNextPage()}>
              Load more
            </Button>
          </div>
        )}
      </Card>
    </>
  );
}
