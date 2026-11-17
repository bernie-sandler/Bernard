import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useEffect, useState } from 'react';
import type {
  MonitorStatusDto,
  StatusMonitorDto,
  StatusResponse,
  StatusTestResponse,
} from '../../../src/shared/api.js';
import { api } from '../api.js';
import { PageHeader } from '../components/Layout.js';
import { ChannelSelect, RoleSelect } from '../components/pickers.js';
import {
  Badge,
  type BadgeTone,
  Button,
  Card,
  EmptyState,
  ErrorBox,
  Field,
  FullPageSpinner,
  Input,
  useToast,
} from '../components/ui.js';
import { relativeTime } from '../format.js';

const STATUS_BADGE: Record<MonitorStatusDto, { tone: BadgeTone; label: string }> = {
  up: { tone: 'green', label: 'Up' },
  down: { tone: 'red', label: 'Down' },
  pending: { tone: 'yellow', label: 'Pending' },
  maintenance: { tone: 'blue', label: 'Maintenance' },
  unknown: { tone: 'gray', label: 'No data' },
};

const uptime = (u: number | null) => (u === null ? '–' : `${(u * 100).toFixed(u >= 0.9999 ? 0 : 2)}%`);

function ConnectionCard({ d }: { d: StatusResponse }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [kumaUrl, setUrl] = useState(d.config.kumaUrl ?? '');
  const [slug, setSlug] = useState(d.config.slug ?? '');
  const [interval, setIntervalSeconds] = useState(String(d.config.intervalSeconds));
  const [alertChannelId, setAlertChannel] = useState(d.config.alertChannelId ?? '');
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    setUrl(d.config.kumaUrl ?? '');
    setSlug(d.config.slug ?? '');
    setIntervalSeconds(String(d.config.intervalSeconds));
    setAlertChannel(d.config.alertChannelId ?? '');
  }, [d.config]);

  const test = useMutation({
    mutationFn: () =>
      api<StatusTestResponse>('/status/test', { method: 'POST', body: { kumaUrl: kumaUrl.trim(), slug } }),
    onSuccess: (r) =>
      setMessage({ ok: true, text: `Connected: “${r.title}” with ${r.monitors} monitor(s).` }),
    onError: (e: Error) => setMessage({ ok: false, text: e.message }),
  });
  const save = useMutation({
    mutationFn: () =>
      api<StatusResponse>('/status/config', {
        method: 'PATCH',
        body: {
          kumaUrl: kumaUrl.trim() || null,
          slug: slug.trim() || null,
          intervalSeconds: Number(interval),
          alertChannelId: alertChannelId || null,
        },
      }),
    onSuccess: (r) => {
      queryClient.setQueryData(['status'], r);
      setMessage(null);
      toast('Status settings saved.');
    },
    onError: (e: Error) => setMessage({ ok: false, text: e.message }),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate();
  };

  return (
    <Card title="Uptime Kuma">
      <form onSubmit={submit} className="space-y-4">
        <p className="text-sm text-slate-400">
          Bernard reads a Kuma <strong>status page</strong>: only monitors on that page are shown in Discord.
        </p>
        <div className="grid gap-3 sm:grid-cols-[1fr_12rem]">
          <Field label="Kuma URL" hint="As Bernard can reach it, e.g. http://192.168.1.10:3001">
            <Input
              value={kumaUrl}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="http://tower:3001"
              maxLength={500}
            />
          </Field>
          <Field label="Status page slug" hint="The part after /status/">
            <Input
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
              placeholder="homelab"
              maxLength={100}
            />
          </Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-[10rem_1fr]">
          <Field label="Update every (s)" hint="60–3600">
            <Input
              type="number"
              min={60}
              max={3600}
              value={interval}
              onChange={(e) => setIntervalSeconds(e.target.value)}
            />
          </Field>
          <Field label="Alert channel" hint="“Down” and “back up” messages. Empty = no alerts.">
            <ChannelSelect
              value={alertChannelId}
              onChange={setAlertChannel}
              kinds={['text', 'announcement']}
              placeholder="No alerts"
            />
          </Field>
        </div>
        {message && (
          <p
            className={
              message.ok
                ? 'rounded-md border border-emerald-500/30 bg-emerald-500/10 p-2 text-sm text-emerald-200'
                : 'rounded-md border border-red-500/30 bg-red-500/10 p-2 text-sm text-red-200'
            }
          >
            {message.text}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button
            variant="secondary"
            onClick={() => test.mutate()}
            loading={test.isPending}
            disabled={!kumaUrl.trim() || !slug.trim()}
          >
            Test connection
          </Button>
          <Button type="submit" loading={save.isPending}>
            Save
          </Button>
        </div>
      </form>
    </Card>
  );
}

function EmbedCard({ d }: { d: StatusResponse }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [channelId, setChannel] = useState(d.config.channelId ?? '');
  useEffect(() => setChannel(d.config.channelId ?? ''), [d.config.channelId]);
  const move = useMutation({
    mutationFn: (id: string | null) =>
      api<StatusResponse>('/status/channel', { method: 'PATCH', body: { channelId: id } }),
    onSuccess: (r, id) => {
      queryClient.setQueryData(['status'], r);
      toast(id ? 'Status embed posted and pinned.' : 'Status embed removed.');
    },
    onError: (e: Error) => toast(e.message, 'error'),
  });
  return (
    <Card title="Pinned embed">
      <div className="space-y-3">
        <p className="text-sm text-slate-400">
          {d.message
            ? 'The embed is posted and edits itself on every update.'
            : 'Pick a channel to post the status embed. Bernard pins it and keeps it up to date.'}
        </p>
        <Field label="Channel">
          <ChannelSelect
            value={channelId}
            onChange={setChannel}
            kinds={['text', 'announcement']}
            disabled={!d.configured}
          />
        </Field>
        <div className="flex justify-end gap-2">
          {d.config.channelId && (
            <Button variant="ghost" className="text-red-300" onClick={() => move.mutate(null)}>
              Remove embed
            </Button>
          )}
          <Button
            onClick={() => move.mutate(channelId)}
            loading={move.isPending}
            disabled={!d.configured || !channelId}
          >
            {d.config.channelId && d.config.channelId !== channelId ? 'Move embed' : 'Post embed'}
          </Button>
        </div>
      </div>
    </Card>
  );
}

function MonitorRow({ m }: { m: StatusMonitorDto }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const setRole = useMutation({
    mutationFn: (roleId: string) =>
      api<StatusResponse>(`/status/monitors/${m.id}/role`, {
        method: 'PATCH',
        body: { roleId: roleId || null },
      }),
    onSuccess: (r) => {
      queryClient.setQueryData(['status'], r);
      toast('Alert role saved.');
    },
    onError: (e: Error) => toast(e.message, 'error'),
  });
  const badge = STATUS_BADGE[m.status];
  return (
    <tr className="border-t border-slate-800">
      <td className="py-2 pr-3">
        <div className="font-medium">{m.name}</div>
        {m.status !== 'up' && m.message && <div className="text-xs text-slate-500">{m.message}</div>}
      </td>
      <td className="py-2 pr-3">
        <Badge tone={badge.tone}>{badge.label}</Badge>
      </td>
      <td className="py-2 pr-3 text-sm text-slate-400 tabular-nums">
        {m.status === 'up' && m.ping !== null ? `${Math.round(m.ping)} ms` : '–'}
      </td>
      <td className="py-2 pr-3 text-sm text-slate-400 tabular-nums">{uptime(m.uptime24h)}</td>
      <td className="py-2 w-56">
        <RoleSelect
          value={m.alertRoleId ?? ''}
          onChange={(v) => setRole.mutate(v)}
          disabled={setRole.isPending}
          placeholder="No ping"
        />
      </td>
    </tr>
  );
}

export function StatusPage() {
  const queryClient = useQueryClient();
  const q = useQuery({
    queryKey: ['status'],
    queryFn: () => api<StatusResponse>('/status'),
    refetchInterval: 60_000,
  });
  const refresh = useMutation({
    mutationFn: () => api<StatusResponse>('/status/refresh', { method: 'POST' }),
    onSuccess: (r) => queryClient.setQueryData(['status'], r),
  });

  if (q.isPending) return <FullPageSpinner />;
  if (q.error) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  const d = q.data;
  const groups = new Map<string, StatusMonitorDto[]>();
  for (const m of d.monitors) groups.set(m.group, [...(groups.get(m.group) ?? []), m]);

  return (
    <>
      <PageHeader
        title="Status"
        subtitle="A pinned Discord embed that shows what's up, fed by your Uptime Kuma status page."
        actions={
          d.configured && (
            <Button variant="secondary" onClick={() => refresh.mutate()} loading={refresh.isPending}>
              Refresh now
            </Button>
          )
        }
      />
      <div className="grid gap-4 lg:grid-cols-2">
        <ConnectionCard d={d} />
        <EmbedCard d={d} />
        <Card
          className="lg:col-span-2"
          title={d.title ? `Monitors · ${d.title}` : 'Monitors'}
          actions={
            d.fetchedAt && <span className="text-xs text-slate-500">read {relativeTime(d.fetchedAt)}</span>
          }
        >
          {d.error && (
            <p className="mb-3 rounded-md border border-amber-500/30 bg-amber-500/10 p-2 text-sm text-amber-200">
              {d.error}
              {d.errorSince ? ` (since ${relativeTime(d.errorSince)})` : ''}
            </p>
          )}
          {!d.configured ? (
            <EmptyState>Connect a Kuma status page above to see its monitors.</EmptyState>
          ) : d.monitors.length === 0 ? (
            <EmptyState>No monitors on this status page yet.</EmptyState>
          ) : (
            <div className="overflow-x-auto">
              <p className="mb-2 text-xs text-slate-500">
                “Ping role” is mentioned in the alert channel when that monitor goes down or comes back, e.g.
                a self-assign “MC updates” role.
              </p>
              <table className="w-full text-left">
                <thead className="text-xs text-slate-500 uppercase">
                  <tr>
                    <th className="pb-1 font-medium">Monitor</th>
                    <th className="pb-1 font-medium">Status</th>
                    <th className="pb-1 font-medium">Ping</th>
                    <th className="pb-1 font-medium">24h</th>
                    <th className="pb-1 font-medium">Ping role</th>
                  </tr>
                </thead>
                {[...groups.entries()].map(([group, list]) => (
                  <tbody key={group}>
                    <tr>
                      <td
                        colSpan={5}
                        className="pt-3 text-xs font-semibold tracking-wide text-slate-400 uppercase"
                      >
                        {group}
                      </td>
                    </tr>
                    {list.map((m) => (
                      <MonitorRow key={m.id} m={m} />
                    ))}
                  </tbody>
                ))}
              </table>
            </div>
          )}
        </Card>
      </div>
    </>
  );
}
