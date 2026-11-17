import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useEffect, useState } from 'react';
import type { BelltowerPriority, BelltowerResponse, IssueReportDto } from '../../../src/shared/api.js';
import { api } from '../api.js';
import { PageHeader } from '../components/Layout.js';
import { ChannelSelect } from '../components/pickers.js';
import { Toggle } from '../components/SettingsForm.js';
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
  Select,
  useToast,
} from '../components/ui.js';
import { relativeTime } from '../format.js';

const KEY = ['belltower'];

const STATE_BADGE: Record<string, { tone: BadgeTone; label: string }> = {
  received: { tone: 'blue', label: 'Received' },
  in_progress: { tone: 'yellow', label: 'In progress' },
  waiting: { tone: 'orange', label: 'Waiting' },
  done: { tone: 'green', label: 'Done' },
  archived: { tone: 'gray', label: 'Archived' },
  deleted: { tone: 'gray', label: 'Deleted' },
  missing: { tone: 'gray', label: 'Gone' },
  duplicate: { tone: 'gray', label: 'Repeat report' },
  dismissed: { tone: 'gray', label: 'Dismissed' },
};

const NOTIFIED: Record<string, string> = { dm: 'by DM', channel: 'in channel', none: 'not told' };

function Notice({ tone, children }: { tone: 'ok' | 'warn' | 'error'; children: React.ReactNode }) {
  const cls = {
    ok: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200',
    warn: 'border-amber-500/30 bg-amber-500/10 text-amber-200',
    error: 'border-red-500/30 bg-red-500/10 text-red-200',
  }[tone];
  return <p className={`rounded-md border p-2 text-sm ${cls}`}>{children}</p>;
}

function ConnectionCard({ d }: { d: BelltowerResponse }) {
  const queryClient = useQueryClient();
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const test = useMutation({
    mutationFn: () => api<BelltowerResponse>('/belltower/test', { method: 'POST' }),
    onSuccess: (r) => {
      queryClient.setQueryData(KEY, r);
      setMessage({ ok: true, text: 'Belltower is reachable and the token works.' });
    },
    onError: (e: Error) => setMessage({ ok: false, text: e.message }),
  });

  if (!d.configured) {
    return (
      <Card title="Belltower">
        <div className="space-y-2 text-sm text-slate-400">
          <p>Reporting is off. To turn it on:</p>
          <ol className="list-decimal space-y-1 pl-5">
            <li>
              In Belltower (1.6 or later), open <strong>Account → Your tokens</strong> and create a{' '}
              <strong>full</strong> token.
            </li>
            <li>
              Set <code>BELLTOWER_URL</code> and <code>BELLTOWER_TOKEN</code> for Bernard and restart it.
            </li>
          </ol>
        </div>
      </Card>
    );
  }
  return (
    <Card title="Belltower">
      <div className="space-y-3">
        <p className="text-sm text-slate-400">
          Members report problems with <code>/report</code> or the report panel. Bernard opens a Belltower
          ticket and tells them when it's done.
          {d.lastPollAt && ` Last checked ${relativeTime(d.lastPollAt)}.`}
        </p>
        {d.error && (
          <Notice tone="warn">
            {d.error}
            {d.errorSince ? ` (since ${relativeTime(d.errorSince)})` : ''}
          </Notice>
        )}
        {message && <Notice tone={message.ok ? 'ok' : 'error'}>{message.text}</Notice>}
        <div className="flex justify-end">
          <Button variant="secondary" onClick={() => test.mutate()} loading={test.isPending}>
            Test connection
          </Button>
        </div>
      </div>
    </Card>
  );
}

function OptionsCard({ d }: { d: BelltowerResponse }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [enabled, setEnabled] = useState(d.config.enabled);
  const [labels, setLabels] = useState(d.config.labels.join(', '));
  const [priority, setPriority] = useState<string>(d.config.priority ?? '');
  const [column, setColumn] = useState(d.config.column ?? '');
  const [cooldown, setCooldown] = useState(String(d.config.cooldownSeconds));

  useEffect(() => {
    setEnabled(d.config.enabled);
    setLabels(d.config.labels.join(', '));
    setPriority(d.config.priority ?? '');
    setColumn(d.config.column ?? '');
    setCooldown(String(d.config.cooldownSeconds));
  }, [d.config]);

  const save = useMutation({
    mutationFn: () =>
      api<BelltowerResponse>('/belltower/config', {
        method: 'PATCH',
        body: {
          enabled,
          labels: labels
            .split(',')
            .map((l) => l.trim())
            .filter(Boolean),
          priority: (priority || null) as BelltowerPriority | null,
          column: column.trim() || null,
          cooldownSeconds: Number(cooldown),
        },
      }),
    onSuccess: (r) => {
      queryClient.setQueryData(KEY, r);
      toast('Report settings saved.');
    },
    onError: (e: Error) => toast(e.message, 'error'),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate();
  };

  return (
    <Card title="New tickets">
      <form onSubmit={submit} className="space-y-4">
        <Toggle
          checked={enabled}
          onChange={setEnabled}
          label="Accept reports"
          hint="Off pauses /report and the panel. Reports already filed are still followed up."
        />
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Tags" hint="Comma-separated. Missing tags are created in Belltower.">
            <Input value={labels} onChange={(e) => setLabels(e.target.value)} placeholder="Discord" />
          </Field>
          <Field label="Priority">
            <Select value={priority} onChange={(e) => setPriority(e.target.value)}>
              <option value="">Belltower's default</option>
              {['P0', 'P1', 'P2', 'P3'].map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Column" hint="Column name in Belltower. Empty = its default.">
            <Input value={column} onChange={(e) => setColumn(e.target.value)} maxLength={100} />
          </Field>
          <Field label="Cooldown (s)" hint="Per member, between reports. 0–3600.">
            <Input
              type="number"
              min={0}
              max={3600}
              value={cooldown}
              onChange={(e) => setCooldown(e.target.value)}
            />
          </Field>
        </div>
        <div className="flex justify-end">
          <Button type="submit" loading={save.isPending}>
            Save
          </Button>
        </div>
      </form>
    </Card>
  );
}

function PanelCard({ d }: { d: BelltowerResponse }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [channelId, setChannel] = useState(d.config.panelChannelId ?? '');
  useEffect(() => setChannel(d.config.panelChannelId ?? ''), [d.config.panelChannelId]);
  const move = useMutation({
    mutationFn: (id: string | null) =>
      api<BelltowerResponse>('/belltower/panel', { method: 'PATCH', body: { channelId: id } }),
    onSuccess: (r, id) => {
      queryClient.setQueryData(KEY, r);
      toast(id ? 'Report panel posted.' : 'Report panel removed.');
    },
    onError: (e: Error) => toast(e.message, 'error'),
  });
  return (
    <Card title="Report panel">
      <div className="space-y-3">
        <p className="text-sm text-slate-400">
          A message with a <strong>Report an issue</strong> button. It opens a short form, so members don't
          need to know the command.
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
          {d.config.panelChannelId && (
            <Button variant="ghost" className="text-red-300" onClick={() => move.mutate(null)}>
              Remove panel
            </Button>
          )}
          <Button
            onClick={() => move.mutate(channelId)}
            loading={move.isPending}
            disabled={!d.configured || !channelId}
          >
            {d.panel && d.panel.channelId === channelId ? 'Re-post panel' : 'Post panel'}
          </Button>
        </div>
      </div>
    </Card>
  );
}

function ReportRow({ r, open }: { r: IssueReportDto; open: boolean }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const dismiss = useMutation({
    mutationFn: () => api<BelltowerResponse>(`/belltower/reports/${r.id}/dismiss`, { method: 'POST' }),
    onSuccess: (res) => {
      queryClient.setQueryData(KEY, res);
      toast('Stopped following that report.');
    },
    onError: (e: Error) => toast(e.message, 'error'),
  });
  const badge = STATE_BADGE[r.state] ?? { tone: 'gray' as const, label: r.state };
  return (
    <tr className="border-t border-slate-800 align-top">
      <td className="py-2 pr-3">
        <div className="font-medium">{r.service}</div>
        {r.details && <div className="line-clamp-2 text-xs text-slate-500">{r.details}</div>}
      </td>
      <td className="py-2 pr-3 text-sm">{r.reporterName ?? r.reporterId}</td>
      <td className="py-2 pr-3 text-sm tabular-nums">
        {r.ticketNo ?? `#${r.cardId}`}
        {r.cardStatus === 'updated' && <div className="text-xs text-slate-500">added to existing</div>}
      </td>
      <td className="py-2 pr-3">
        <Badge tone={badge.tone}>{badge.label}</Badge>
        {r.resolution && <div className="mt-1 text-xs text-slate-500">{r.resolution}</div>}
      </td>
      <td className="py-2 pr-3 text-sm text-slate-400">
        {open ? (
          relativeTime(r.createdAt)
        ) : (
          <>
            {r.closedAt ? relativeTime(r.closedAt) : '–'}
            {r.notifiedVia && <div className="text-xs text-slate-500">{NOTIFIED[r.notifiedVia]}</div>}
          </>
        )}
      </td>
      {open && (
        <td className="py-2 text-right">
          <Button size="sm" variant="ghost" onClick={() => dismiss.mutate()} loading={dismiss.isPending}>
            Dismiss
          </Button>
        </td>
      )}
    </tr>
  );
}

function ReportTable({ rows, open }: { rows: IssueReportDto[]; open: boolean }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left">
        <thead className="text-xs text-slate-500 uppercase">
          <tr>
            <th className="pb-1 font-medium">Service</th>
            <th className="pb-1 font-medium">Reported by</th>
            <th className="pb-1 font-medium">Ticket</th>
            <th className="pb-1 font-medium">State</th>
            <th className="pb-1 font-medium">{open ? 'Reported' : 'Closed'}</th>
            {open && <th className="pb-1" />}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <ReportRow key={r.id} r={r} open={open} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ReportsPage() {
  const queryClient = useQueryClient();
  const q = useQuery({
    queryKey: KEY,
    queryFn: () => api<BelltowerResponse>('/belltower'),
    refetchInterval: 60_000,
  });
  const poll = useMutation({
    mutationFn: () => api<BelltowerResponse>('/belltower/poll', { method: 'POST' }),
    onSuccess: (r) => queryClient.setQueryData(KEY, r),
  });

  if (q.isPending) return <FullPageSpinner />;
  if (q.error) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  const d = q.data;

  return (
    <>
      <PageHeader
        title="Issue reports"
        subtitle="Problems members report in Discord, filed as Belltower tickets. Reporters hear back when they're fixed."
        actions={
          d.configured &&
          d.open.length > 0 && (
            <Button variant="secondary" onClick={() => poll.mutate()} loading={poll.isPending}>
              Check now
            </Button>
          )
        }
      />
      <div className="grid gap-4 lg:grid-cols-2">
        <ConnectionCard d={d} />
        <PanelCard d={d} />
        <div className="lg:col-span-2">
          <OptionsCard d={d} />
        </div>
        <Card className="lg:col-span-2" title={`Open reports (${d.open.length})`}>
          {d.open.length === 0 ? (
            <EmptyState>No open reports.</EmptyState>
          ) : (
            <ReportTable rows={d.open} open />
          )}
        </Card>
        <Card className="lg:col-span-2" title="Recently closed">
          {d.recent.length === 0 ? (
            <EmptyState>Nothing closed yet.</EmptyState>
          ) : (
            <ReportTable rows={d.recent} open={false} />
          )}
        </Card>
      </div>
    </>
  );
}
