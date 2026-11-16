import { useInfiniteQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router';
import type { CaseListResponse } from '../../../src/shared/api.js';
import { api, qs } from '../api.js';
import { CaseTable } from '../components/CaseTable.js';
import { PageHeader } from '../components/Layout.js';
import { Button, Card, ErrorBox, Field, Input, Select, Spinner } from '../components/ui.js';

const ACTIONS = [
  'ban',
  'unban',
  'kick',
  'timeout',
  'untimeout',
  'warn',
  'purge',
  'role_add',
  'role_remove',
  'nick',
  'slowmode',
  'lock',
  'unlock',
];
const SOURCES = ['slash', 'dashboard', 'discord', 'system'];
const ID = /^\d{17,20}$/;

export function ModerationPage() {
  const [params, setParams] = useSearchParams();
  const filters = {
    action: params.get('action') ?? '',
    source: params.get('source') ?? '',
    target: params.get('target') ?? '',
    moderator: params.get('moderator') ?? '',
  };
  const set = (k: keyof typeof filters, v: string) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    setParams(next, { replace: true });
  };

  const q = useInfiniteQuery({
    queryKey: ['cases', filters],
    initialPageParam: undefined as number | undefined,
    queryFn: ({ pageParam }) =>
      api<CaseListResponse>(
        `/cases${qs({
          action: filters.action,
          source: filters.source,
          target: ID.test(filters.target) ? filters.target : undefined,
          moderator: ID.test(filters.moderator) ? filters.moderator : undefined,
          before: pageParam,
          limit: 50,
        })}`,
      ),
    getNextPageParam: (last) => last.nextBefore ?? undefined,
  });

  const items = q.data?.pages.flatMap((p) => p.items) ?? [];
  const mentions = q.data?.pages.reduce(
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
        title="Moderation"
        subtitle="Every mod case, from slash commands, the dashboard and Discord itself."
      />
      <Card className="mb-4">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Action">
            <Select value={filters.action} onChange={(e) => set('action', e.target.value)}>
              <option value="">All actions</option>
              {ACTIONS.map((a) => (
                <option key={a} value={a}>
                  {a.replace('_', ' ')}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Source">
            <Select value={filters.source} onChange={(e) => set('source', e.target.value)}>
              <option value="">All sources</option>
              {SOURCES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Target user ID">
            <Input
              value={filters.target}
              onChange={(e) => set('target', e.target.value.trim())}
              placeholder="Any"
              inputMode="numeric"
            />
          </Field>
          <Field label="Moderator user ID">
            <Input
              value={filters.moderator}
              onChange={(e) => set('moderator', e.target.value.trim())}
              placeholder="Any"
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
        ) : (
          <>
            <CaseTable cases={items} {...(mentions ? { mentions } : {})} />
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
