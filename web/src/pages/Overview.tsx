import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { OverviewResponse } from '../../../src/shared/api.js';
import { api } from '../api.js';
import { CaseTable } from '../components/CaseTable.js';
import { PageHeader } from '../components/Layout.js';
import { Avatar, Badge, Card, EmptyState, ErrorBox, FullPageSpinner, Stat } from '../components/ui.js';
import { number, relativeTime, uptime } from '../format.js';

export function OverviewPage() {
  const q = useQuery({
    queryKey: ['overview'],
    queryFn: () => api<OverviewResponse>('/overview'),
    refetchInterval: 60_000,
  });
  if (q.isPending) return <FullPageSpinner />;
  if (q.error) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  const d = q.data;
  const joins = d.joinsLeaves.reduce((s, x) => s + x.joins, 0);
  const leaves = d.joinsLeaves.reduce((s, x) => s + x.leaves, 0);
  const voiceUsers = d.voice.reduce((s, v) => s + v.members.length, 0);
  const failingJobs = d.health.jobs.filter((j) => j.lastError);

  return (
    <>
      <PageHeader title="Overview" subtitle={`${d.guild.name} at a glance`} />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat
          label="Members"
          value={number(d.guild.memberCount)}
          hint={`+${joins} / −${leaves} in ${d.joinsLeaves.length} days`}
        />
        <Stat
          label="Online"
          value={d.guild.onlineCount === null ? '—' : number(d.guild.onlineCount)}
          hint="Discord's approximate count"
        />
        <Stat label="Temp voice channels" value={d.voice.length} hint={`${voiceUsers} member(s) connected`} />
        <Stat
          label="Last tier sync"
          value={d.health.lastTierSync ? relativeTime(d.health.lastTierSync.at) : 'Never'}
          hint={
            d.health.lastTierSync
              ? `${d.health.lastTierSync.changed} changed of ${d.health.lastTierSync.members}`
              : undefined
          }
        />
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <Card title="Joins & leaves" className="lg:col-span-2">
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={d.joinsLeaves} margin={{ left: -20, right: 4 }}>
                <CartesianGrid stroke="#1e293b" vertical={false} />
                <XAxis
                  dataKey="date"
                  tickFormatter={(v: string) => v.slice(5)}
                  stroke="#64748b"
                  fontSize={11}
                  tickLine={false}
                />
                <YAxis
                  allowDecimals={false}
                  stroke="#64748b"
                  fontSize={11}
                  tickLine={false}
                  axisLine={false}
                />
                <Tooltip cursor={{ fill: '#1e293b' }} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Bar dataKey="joins" name="Joins" fill="#34d399" radius={[3, 3, 0, 0]} />
                <Bar dataKey="leaves" name="Leaves" fill="#f87171" radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Card>

        <Card title="Bot health">
          <dl className="grid grid-cols-2 gap-y-3 text-sm">
            <dt className="text-slate-400">Status</dt>
            <dd>
              {d.health.ready ? (
                <Badge tone="green">Connected</Badge>
              ) : (
                <Badge tone="red">Disconnected</Badge>
              )}
            </dd>
            <dt className="text-slate-400">Gateway latency</dt>
            <dd>{d.health.wsPingMs === null || d.health.wsPingMs < 0 ? '—' : `${d.health.wsPingMs} ms`}</dd>
            <dt className="text-slate-400">Bot uptime</dt>
            <dd>{uptime(d.health.botUptimeSec)}</dd>
            <dt className="text-slate-400">Process uptime</dt>
            <dd>{uptime(d.health.processUptimeSec)}</dd>
            <dt className="text-slate-400">Scheduled jobs</dt>
            <dd>
              {failingJobs.length ? (
                <Badge tone="red">{failingJobs.length} failing</Badge>
              ) : d.health.jobs.length ? (
                <Badge tone="green">{d.health.jobs.length} OK</Badge>
              ) : (
                <span className="text-slate-500">Starting…</span>
              )}
            </dd>
          </dl>
          {failingJobs.length > 0 && (
            <ul className="mt-3 space-y-1 text-xs text-red-300">
              {failingJobs.map((j) => (
                <li key={j.name}>
                  <strong>{j.name}</strong>: {j.lastError}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card title={`Most active (${d.activityWindowDays} days)`}>
          {d.topMembers.length === 0 ? (
            <EmptyState>No activity recorded yet.</EmptyState>
          ) : (
            <ol className="divide-y divide-slate-800">
              {d.topMembers.map((m, i) => (
                <li key={m.id} className="flex items-center gap-3 py-2">
                  <span className="w-5 text-right font-mono text-xs text-slate-500">{i + 1}</span>
                  <Avatar url={m.avatarUrl} name={m.name} size={28} />
                  <Link
                    to={`/members/${m.id}`}
                    className="min-w-0 flex-1 truncate text-sm hover:text-indigo-300"
                  >
                    {m.name}
                  </Link>
                  <span className="text-xs text-slate-500">
                    {m.messagePoints} msg · {m.voiceMinutes} min
                  </span>
                  <span className="w-14 text-right text-sm font-semibold">{number(m.score)}</span>
                </li>
              ))}
            </ol>
          )}
        </Card>

        <Card title="Active voice channels">
          {d.voice.length === 0 ? (
            <EmptyState>No temporary voice channels right now.</EmptyState>
          ) : (
            <ul className="space-y-3">
              {d.voice.map((v) => (
                <li key={v.channelId} className="rounded-lg border border-slate-800 p-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-sm font-medium">🔊 {v.name}</span>
                    <span className="text-xs text-slate-500">{v.members.length} connected</span>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {v.members.map((m) => (
                      <Link
                        key={m.id}
                        to={`/members/${m.id}`}
                        className="flex items-center gap-1.5 rounded-full bg-slate-800 py-0.5 pr-2.5 pl-0.5 text-xs hover:bg-slate-700"
                      >
                        <Avatar url={m.avatarUrl} name={m.name} size={20} />
                        {m.name}
                        {v.owner?.id === m.id && <span title="Owner">👑</span>}
                      </Link>
                    ))}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      {d.canViewCases && (
        <Card
          title="Recent mod cases"
          className="mt-4"
          actions={
            <Link to="/moderation" className="text-xs text-indigo-300 hover:underline">
              View all
            </Link>
          }
        >
          <CaseTable cases={d.recentCases} compact />
        </Card>
      )}
    </>
  );
}
