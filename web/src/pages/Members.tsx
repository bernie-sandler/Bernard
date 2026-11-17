import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { activitySummary, type MemberListResponse, type MemberSort } from '../../../src/shared/api.js';
import { api, qs } from '../api.js';
import { PageHeader } from '../components/Layout.js';
import { Avatar, Badge, Button, Card, cx, EmptyState, ErrorBox, Input, Spinner } from '../components/ui.js';
import { date, number } from '../format.js';

const PAGE_SIZE = 25;

function SortHeader({
  s,
  sort,
  order,
  onSort,
  children,
}: {
  s: MemberSort;
  sort: MemberSort;
  order: 'asc' | 'desc';
  onSort: (s: MemberSort) => void;
  children: React.ReactNode;
}) {
  return (
    <th
      className="px-3 py-2 font-medium"
      aria-sort={sort === s ? (order === 'asc' ? 'ascending' : 'descending') : 'none'}
    >
      <button
        type="button"
        onClick={() => onSort(s)}
        className={cx(
          'inline-flex items-center gap-1 uppercase hover:text-slate-200',
          sort === s && 'text-slate-200',
        )}
      >
        {children}
        {sort === s && <span aria-hidden>{order === 'asc' ? '▲' : '▼'}</span>}
      </button>
    </th>
  );
}

export function MembersPage() {
  const [params, setParams] = useSearchParams();
  const sort = (params.get('sort') as MemberSort | null) ?? 'activity';
  const order = (params.get('order') as 'asc' | 'desc' | null) ?? (sort === 'name' ? 'asc' : 'desc');
  const page = Number(params.get('page') ?? '1') || 1;
  const search = params.get('search') ?? '';
  const [draft, setDraft] = useState(search);

  // Debounce typing into the search box.
  useEffect(() => {
    const t = setTimeout(() => {
      if (draft === search) return;
      const next = new URLSearchParams(params);
      if (draft) next.set('search', draft);
      else next.delete('search');
      next.delete('page');
      setParams(next, { replace: true });
    }, 300);
    return () => clearTimeout(t);
  }, [draft, search, params, setParams]);

  const q = useQuery({
    queryKey: ['members', { sort, order, page, search }],
    queryFn: () =>
      api<MemberListResponse>(`/members${qs({ sort, order, page, pageSize: PAGE_SIZE, search })}`),
    placeholderData: keepPreviousData,
  });

  const setSort = (s: MemberSort) => {
    const next = new URLSearchParams(params);
    if (s === sort) next.set('order', order === 'asc' ? 'desc' : 'asc');
    else {
      next.set('sort', s);
      next.delete('order');
    }
    next.delete('page');
    setParams(next);
  };
  const setPage = (p: number) => {
    const next = new URLSearchParams(params);
    next.set('page', String(p));
    setParams(next);
  };

  const showWarnings = q.data?.items.some((i) => i.warnings !== null) ?? false;
  const pages = q.data ? Math.max(1, Math.ceil(q.data.total / q.data.pageSize)) : 1;

  return (
    <>
      <PageHeader
        title="Members"
        subtitle={q.data ? `${number(q.data.total)} current member(s)` : undefined}
        actions={
          <div className="w-full sm:w-72">
            <Input
              type="search"
              placeholder="Search by name or ID…"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              aria-label="Search members"
            />
          </div>
        }
      />
      <Card>
        {q.error ? (
          <ErrorBox error={q.error} onRetry={() => q.refetch()} />
        ) : !q.data ? (
          <div className="flex justify-center py-10">
            <Spinner />
          </div>
        ) : q.data.items.length === 0 ? (
          <EmptyState>No members match.</EmptyState>
        ) : (
          <div className="-mx-4 overflow-x-auto sm:mx-0">
            <table className={cx('w-full min-w-[720px] text-left text-sm', q.isFetching && 'opacity-70')}>
              <thead className="text-xs text-slate-500">
                <tr className="border-b border-slate-800">
                  <SortHeader sort={sort} order={order} onSort={setSort} s="name">
                    Member
                  </SortHeader>
                  <SortHeader sort={sort} order={order} onSort={setSort} s="tenure">
                    Tenure
                  </SortHeader>
                  <SortHeader sort={sort} order={order} onSort={setSort} s="activity">
                    Activity
                  </SortHeader>
                  <th className="px-3 py-2 font-medium uppercase">Tier</th>
                  {showWarnings && (
                    <SortHeader sort={sort} order={order} onSort={setSort} s="warnings">
                      Warnings
                    </SortHeader>
                  )}
                  <th className="px-3 py-2 font-medium uppercase">Joined</th>
                </tr>
              </thead>
              <tbody>
                {q.data.items.map((m) => (
                  <tr
                    key={m.userId}
                    className="border-b border-slate-800/60 last:border-0 hover:bg-slate-800/30"
                  >
                    <td className="px-3 py-2">
                      <Link to={`/members/${m.userId}`} className="flex items-center gap-3">
                        <Avatar url={m.avatarUrl} name={m.displayName} size={32} />
                        <span className="min-w-0">
                          <span className="block truncate font-medium text-slate-100">
                            {m.displayName} {m.isBot && <Badge tone="blue">BOT</Badge>}
                          </span>
                          <span className="block truncate text-xs text-slate-500">@{m.username}</span>
                        </span>
                      </Link>
                    </td>
                    <td className="px-3 py-2 text-slate-300">{number(m.tenureDays)} d</td>
                    <td className="px-3 py-2">
                      <div className="font-semibold">{number(m.score)}</div>
                      <div className="text-xs text-slate-500">{activitySummary(m)}</div>
                    </td>
                    <td className="px-3 py-2">
                      {m.tier ? (
                        <Badge tone="blue">{m.tier.name}</Badge>
                      ) : (
                        <span className="text-slate-600">—</span>
                      )}
                    </td>
                    {showWarnings && (
                      <td className="px-3 py-2">
                        {m.warnings ? (
                          <Badge tone="yellow">{m.warnings}</Badge>
                        ) : (
                          <span className="text-slate-600">0</span>
                        )}
                      </td>
                    )}
                    <td className="px-3 py-2 whitespace-nowrap text-slate-400">{date(m.joinedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {q.data && pages > 1 && (
          <div className="mt-4 flex items-center justify-between text-sm text-slate-400">
            <span>
              Page {page} of {pages}
            </span>
            <div className="flex gap-2">
              <Button size="sm" variant="secondary" disabled={page <= 1} onClick={() => setPage(page - 1)}>
                Previous
              </Button>
              <Button
                size="sm"
                variant="secondary"
                disabled={page >= pages}
                onClick={() => setPage(page + 1)}
              >
                Next
              </Button>
            </div>
          </div>
        )}
      </Card>
    </>
  );
}
