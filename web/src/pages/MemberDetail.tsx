import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { Link, useParams } from 'react-router';
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { ActionResponse, MemberDetailResponse, RoleDto } from '../../../src/shared/api.js';
import { api } from '../api.js';
import { CaseTable } from '../components/CaseTable.js';
import {
  Avatar,
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorBox,
  Field,
  FullPageSpinner,
  Input,
  Modal,
  Select,
  Textarea,
  useToast,
} from '../components/ui.js';
import { date, dateTime, number, relativeTime, roleColor } from '../format.js';

type Action = 'warn' | 'timeout' | 'untimeout' | 'kick' | 'ban';

const ACTIONS: Record<Action, { label: string; variant: 'secondary' | 'danger'; confirm: string }> = {
  warn: { label: 'Warn', variant: 'secondary', confirm: 'Warn member' },
  timeout: { label: 'Timeout', variant: 'secondary', confirm: 'Time out' },
  untimeout: { label: 'Remove timeout', variant: 'secondary', confirm: 'Remove timeout' },
  kick: { label: 'Kick', variant: 'danger', confirm: 'Kick member' },
  ban: { label: 'Ban', variant: 'danger', confirm: 'Ban user' },
};

export function MemberDetailPage() {
  const { id = '' } = useParams();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [action, setAction] = useState<Action | null>(null);
  const q = useQuery({
    queryKey: ['member', id],
    queryFn: () => api<MemberDetailResponse>(`/members/${id}`),
  });
  const roles = useQuery({
    queryKey: ['roles'],
    queryFn: () => api<RoleDto[]>('/roles'),
    enabled: Boolean(q.data?.can.role),
  });

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['member', id] });
    void queryClient.invalidateQueries({ queryKey: ['members'] });
  };
  const roleMutation = useMutation({
    mutationFn: (body: { roleId: string; add: boolean }) =>
      api<ActionResponse>(`/members/${id}/roles`, { method: 'POST', body }),
    onSuccess: (r) => {
      toast(`${r.message} (case #${r.caseNumber})`);
      refresh();
    },
    onError: (e: Error) => toast(e.message, 'error'),
  });

  if (q.isPending) return <FullPageSpinner />;
  if (q.error) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  const m = q.data;
  const held = new Set(m.roles.map((r) => r.id));
  const addable = (roles.data ?? []).filter((r) => r.assignable && !held.has(r.id));
  const available = (Object.keys(ACTIONS) as Action[]).filter((a) => {
    if (!m.can[a] || !m.inGuild) return a === 'ban' && m.can.ban && !m.inGuild;
    if (a === 'timeout') return !m.timedOutUntil;
    if (a === 'untimeout') return Boolean(m.timedOutUntil);
    return true;
  });

  return (
    <>
      <Link to="/members" className="text-sm text-slate-400 hover:text-slate-200">
        ← Members
      </Link>

      <div className="mt-3 flex flex-wrap items-center gap-4">
        <Avatar url={m.avatarUrl} name={m.displayName} size={64} />
        <div className="min-w-0 flex-1">
          <h1 className="flex flex-wrap items-center gap-2 text-2xl font-semibold text-slate-50">
            {m.displayName}
            {m.isBot && <Badge tone="blue">BOT</Badge>}
            {!m.inGuild && <Badge tone="red">Not in server</Badge>}
            {m.timedOutUntil && <Badge tone="yellow">Timed out until {dateTime(m.timedOutUntil)}</Badge>}
            {m.activeWarnings ? <Badge tone="yellow">{m.activeWarnings} warning(s)</Badge> : null}
          </h1>
          <p className="text-sm text-slate-400">
            @{m.username} · <span className="font-mono text-xs">{m.userId}</span>
          </p>
        </div>
        {available.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {available.map((a) => (
              <Button key={a} variant={ACTIONS[a].variant} onClick={() => setAction(a)}>
                {ACTIONS[a].label}
              </Button>
            ))}
          </div>
        )}
      </div>

      <div className="mt-6 grid gap-4 lg:grid-cols-3">
        <Card title="Membership">
          <dl className="grid grid-cols-2 gap-y-2 text-sm">
            <dt className="text-slate-400">Tenure</dt>
            <dd>{m.tenureDays === null ? '—' : `${number(m.tenureDays)} days`}</dd>
            <dt className="text-slate-400">Joined</dt>
            <dd title={dateTime(m.joinedAt)}>{date(m.joinedAt)}</dd>
            {m.firstJoinedAt && m.firstJoinedAt !== m.joinedAt && (
              <>
                <dt className="text-slate-400">First joined</dt>
                <dd>{date(m.firstJoinedAt)}</dd>
              </>
            )}
            {m.leftAt && (
              <>
                <dt className="text-slate-400">Left</dt>
                <dd>{date(m.leftAt)}</dd>
              </>
            )}
            <dt className="text-slate-400">Account created</dt>
            <dd title={dateTime(m.accountCreatedAt)}>
              {m.accountCreatedAt ? relativeTime(m.accountCreatedAt) : '—'}
            </dd>
            {m.nickname && (
              <>
                <dt className="text-slate-400">Nickname</dt>
                <dd>{m.nickname}</dd>
              </>
            )}
          </dl>
        </Card>

        <Card title="Tier">
          <div className="text-sm">
            <div className="text-slate-400">Current</div>
            <div className="mt-1 text-lg font-semibold">{m.tier.current?.name ?? 'None'}</div>
            <div className="mt-3 text-slate-400">Next</div>
            {m.tier.next ? (
              <div className="mt-1">
                <span className="font-medium">{m.tier.next.name}</span>
                <span className="text-slate-400">
                  {' '}
                  {m.tier.next.daysNeeded === 0 && m.tier.next.pointsNeeded === 0
                    ? '(requirements met; applied at the next sync)'
                    : `needs ${[
                        m.tier.next.daysNeeded ? `${m.tier.next.daysNeeded} more day(s)` : null,
                        m.tier.next.pointsNeeded ? `${number(m.tier.next.pointsNeeded)} more activity` : null,
                      ]
                        .filter(Boolean)
                        .join(' and ')}`}
                </span>
              </div>
            ) : (
              <div className="mt-1 text-slate-300">
                {m.tier.current ? 'Top tier reached' : 'No tiers configured'}
              </div>
            )}
          </div>
        </Card>

        <Card title="Roles">
          {m.roles.length === 0 ? (
            <p className="text-sm text-slate-500">No roles.</p>
          ) : (
            <ul className="flex flex-wrap gap-1.5">
              {m.roles.map((r) => (
                <li
                  key={r.id}
                  className="flex items-center gap-1 rounded-full border border-slate-700 bg-slate-800/60 py-0.5 pr-1 pl-2 text-xs"
                >
                  <span className="size-2.5 rounded-full" style={{ backgroundColor: roleColor(r.color) }} />
                  {r.name}
                  {m.can.role && r.assignable ? (
                    <button
                      type="button"
                      aria-label={`Remove ${r.name}`}
                      disabled={roleMutation.isPending}
                      onClick={() => {
                        if (window.confirm(`Remove ${r.name} from ${m.displayName}?`))
                          roleMutation.mutate({ roleId: r.id, add: false });
                      }}
                      className="ml-0.5 rounded-full px-1 text-slate-400 hover:bg-slate-700 hover:text-red-300"
                    >
                      ×
                    </button>
                  ) : (
                    <span className="w-1" />
                  )}
                </li>
              ))}
            </ul>
          )}
          {m.can.role && m.inGuild && addable.length > 0 && (
            <form
              className="mt-3 flex flex-wrap gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                const roleId = new FormData(e.currentTarget).get('role') as string;
                if (roleId) roleMutation.mutate({ roleId, add: true });
                e.currentTarget.reset();
              }}
            >
              <Select name="role" defaultValue="" aria-label="Role to add" className="min-w-0 flex-1">
                <option value="" disabled>
                  Add a role…
                </option>
                {addable.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </Select>
              <Button type="submit" variant="secondary" loading={roleMutation.isPending}>
                Add
              </Button>
            </form>
          )}
        </Card>
      </div>

      <Card
        className="mt-4"
        title={`Activity (${m.activity.windowDays} days)`}
        actions={
          <span className="text-sm text-slate-400">
            {m.activity.rank ? `Rank #${m.activity.rank}` : 'Unranked'}
          </span>
        }
      >
        <div className="mb-4 grid grid-cols-3 gap-3 text-center">
          <div>
            <div className="text-2xl font-semibold">{number(m.activity.score)}</div>
            <div className="text-xs text-slate-500">points</div>
          </div>
          <div>
            <div className="text-2xl font-semibold">{number(m.activity.messagePoints)}</div>
            <div className="text-xs text-slate-500">counted messages</div>
          </div>
          <div>
            <div className="text-2xl font-semibold">{number(m.activity.voiceMinutes)}</div>
            <div className="text-xs text-slate-500">voice minutes</div>
          </div>
        </div>
        {m.activity.history.length === 0 ? (
          <EmptyState>No activity in the last 90 days.</EmptyState>
        ) : (
          <div className="h-56">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={m.activity.history} margin={{ left: -20, right: 4 }}>
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
                <Bar dataKey="messagePoints" name="Messages" stackId="a" fill="#818cf8" />
                <Bar
                  dataKey="voiceMinutes"
                  name="Voice minutes"
                  stackId="a"
                  fill="#34d399"
                  radius={[3, 3, 0, 0]}
                />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </Card>

      {m.cases && (
        <Card className="mt-4" title={`Moderation history (${m.cases.length})`}>
          <CaseTable cases={m.cases} mentions={m.mentions} />
        </Card>
      )}

      {action && (
        <ActionDialog
          action={action}
          member={m}
          onClose={() => setAction(null)}
          onDone={(r) => {
            setAction(null);
            toast(`${r.message}${r.caseNumber ? ` (case #${r.caseNumber})` : ''}`);
            refresh();
          }}
        />
      )}
    </>
  );
}

function ActionDialog({
  action,
  member,
  onClose,
  onDone,
}: {
  action: Action;
  member: MemberDetailResponse;
  onClose: () => void;
  onDone: (r: ActionResponse) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const mutation = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api<ActionResponse>(`/members/${member.userId}/${action}`, { method: 'POST', body }),
    onSuccess: onDone,
    onError: (e: Error) => setError(e.message),
  });

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);
    const f = new FormData(e.currentTarget);
    const str = (k: string) => {
      const v = String(f.get(k) ?? '').trim();
      return v || undefined;
    };
    const body: Record<string, unknown> = {};
    if (str('reason')) body.reason = str('reason');
    if (action === 'timeout' || action === 'ban') {
      if (str('duration')) body.duration = str('duration');
    }
    if (action === 'ban' && str('deleteDays')) body.deleteDays = Number(str('deleteDays'));
    mutation.mutate(body);
  };

  return (
    <Modal open title={`${ACTIONS[action].label}: ${member.displayName}`} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        {(action === 'timeout' || action === 'ban') && (
          <Field
            label={action === 'timeout' ? 'Duration' : 'Duration (optional)'}
            hint={
              action === 'timeout'
                ? 'e.g. 10m, 2h, 3d (max 28d)'
                : 'Leave empty for a permanent ban, or e.g. 7d'
            }
          >
            <Input
              name="duration"
              required={action === 'timeout'}
              placeholder={action === 'timeout' ? '1h' : 'permanent'}
            />
          </Field>
        )}
        {action === 'ban' && (
          <Field label="Delete message history">
            <Select name="deleteDays" defaultValue="0">
              {[0, 1, 2, 3, 7].map((d) => (
                <option key={d} value={d}>
                  {d === 0 ? "Don't delete" : `Last ${d} day(s)`}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <Field
          label={action === 'warn' ? 'Reason' : 'Reason (optional)'}
          hint="Shown in the mod log and sent to the member by DM when enabled."
        >
          <Textarea name="reason" required={action === 'warn'} maxLength={500} />
        </Field>
        {error && (
          <p className="rounded-md border border-red-500/30 bg-red-500/10 p-2 text-sm text-red-200">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            variant={ACTIONS[action].variant === 'danger' ? 'danger' : 'primary'}
            loading={mutation.isPending}
          >
            {ACTIONS[action].confirm}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
