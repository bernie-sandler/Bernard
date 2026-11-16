import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useMemo, useState } from 'react';
import type { PermissionCheckResponse, PermissionsResponse } from '../../../src/shared/api.js';
import { api } from '../api.js';
import { useAuth } from '../auth.js';
import { PageHeader } from '../components/Layout.js';
import { MemberPicker } from '../components/pickers.js';
import {
  Badge,
  Button,
  Card,
  cx,
  ErrorBox,
  Field,
  FullPageSpinner,
  Input,
  Select,
  useToast,
} from '../components/ui.js';
import { roleColor } from '../format.js';

type Value = boolean | null;

const CATEGORY_TITLES: Record<string, string> = {
  admin: 'Moderation (admin)',
  config: 'Configuration (config)',
  public: 'General (public)',
  voice: 'Voice channels (voice)',
  dashboard: 'Dashboard (dashboard)',
};

function TriState({
  value,
  onChange,
  disabled,
  label,
}: {
  value: Value;
  onChange: (v: Value) => void;
  disabled: boolean;
  label: string;
}) {
  const opts: { v: Value; text: string; active: string }[] = [
    { v: true, text: 'Allow', active: 'bg-emerald-600 text-white' },
    { v: null, text: 'Unset', active: 'bg-slate-600 text-white' },
    { v: false, text: 'Deny', active: 'bg-red-600 text-white' },
  ];
  return (
    <fieldset className="inline-flex overflow-hidden rounded-md border border-slate-700">
      <legend className="sr-only">{label}</legend>
      {opts.map((o) => (
        <button
          key={o.text}
          type="button"
          aria-pressed={value === o.v}
          disabled={disabled}
          onClick={() => value !== o.v && onChange(o.v)}
          className={cx(
            'px-2.5 py-1 text-xs font-medium transition-colors disabled:cursor-not-allowed',
            value === o.v ? o.active : 'bg-slate-900 text-slate-400 hover:bg-slate-800',
          )}
        >
          {o.text}
        </button>
      ))}
    </fieldset>
  );
}

function CheckTool({ nodes }: { nodes: string[] }) {
  const [userId, setUserId] = useState('');
  const [node, setNode] = useState('');
  const check = useMutation({
    mutationFn: () =>
      api<PermissionCheckResponse>('/permissions/check', { method: 'POST', body: { userId, node } }),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    check.mutate();
  };
  return (
    <Card title="Check a member">
      <form onSubmit={submit} className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
        <Field label="Member">
          <MemberPicker value={userId} onChange={setUserId} required />
        </Field>
        <Field label="Node">
          <Select value={node} onChange={(e) => setNode(e.target.value)} required>
            <option value="">Choose a node…</option>
            {nodes.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </Select>
        </Field>
        <Button type="submit" loading={check.isPending} disabled={!userId || !node}>
          Check
        </Button>
      </form>
      {check.error && (
        <div className="mt-3">
          <ErrorBox error={check.error} />
        </div>
      )}
      {check.data && (
        <div
          className={cx(
            'mt-3 rounded-md border p-3 text-sm',
            check.data.allowed
              ? 'border-emerald-500/30 bg-emerald-500/10'
              : 'border-red-500/30 bg-red-500/10',
          )}
        >
          <div className="font-semibold">
            {check.data.allowed ? '✅ Allowed' : '⛔ Denied'}: {check.data.member.name} →{' '}
            <code>{check.data.node}</code>
          </div>
          <div className="mt-1 text-slate-300">{check.data.explanation.replace(/`/g, '')}</div>
        </div>
      )}
    </Card>
  );
}

export function PermissionsPage() {
  const { can } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();
  const q = useQuery({ queryKey: ['permissions'], queryFn: () => api<PermissionsResponse>('/permissions') });
  const [roleId, setRoleId] = useState<string | null>(null);
  const [roleFilter, setRoleFilter] = useState('');

  const set = useMutation({
    mutationFn: (body: { roleId: string; node: string; value: Value }) =>
      api('/permissions', { method: 'POST', body }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['permissions'] }),
    onError: (e: Error) => toast(e.message, 'error'),
  });

  const ruleCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of q.data?.rules ?? []) m.set(r.roleId, (m.get(r.roleId) ?? 0) + 1);
    return m;
  }, [q.data]);

  if (q.isPending) return <FullPageSpinner />;
  if (q.error) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  const d = q.data;
  const everyone = d.roles.find((r) => r.isEveryone)!;
  const current =
    d.roles.find((r) => r.id === roleId) ?? d.roles.find((r) => ruleCounts.has(r.id)) ?? everyone;
  const rulesFor = new Map(d.rules.filter((r) => r.roleId === current.id).map((r) => [r.node, r.allow]));
  const groups = new Map<string, typeof d.nodes>();
  for (const n of d.nodes) {
    const cat = n.node === '*' ? '*' : n.node.split(':')[0]!;
    groups.set(cat, [...(groups.get(cat) ?? []), n]);
  }
  const ordered = [...groups.entries()].sort(([a], [b]) =>
    a === '*' ? -1 : b === '*' ? 1 : a.localeCompare(b),
  );
  const editable = can('config:permset');
  const roles = d.roles.filter((r) => r.name.toLowerCase().includes(roleFilter.trim().toLowerCase()));

  return (
    <>
      <PageHeader
        title="Permissions"
        subtitle="Pick a role and set each node to allow, deny or unset. The most specific rule wins; between roles deny wins; named roles beat @everyone."
      />
      <div className="mb-4 rounded-lg border border-slate-800 bg-slate-900/50 p-3 text-sm text-slate-400">
        The server owner always has access.{' '}
        {d.adminBypass
          ? 'Members with Discord’s Administrator permission also bypass these rules.'
          : 'Administrator bypass is off.'}{' '}
        With no matching rule, <code>public:*</code> and <code>voice:*</code> are allowed and everything else
        is denied.
      </div>
      <div className="grid gap-4 lg:grid-cols-[16rem_minmax(0,1fr)]">
        <Card className="lg:max-h-[calc(100vh-14rem)] lg:overflow-y-auto">
          <Input
            type="search"
            placeholder="Filter roles…"
            value={roleFilter}
            onChange={(e) => setRoleFilter(e.target.value)}
            aria-label="Filter roles"
          />
          <ul className="mt-3 space-y-0.5">
            {roles.map((r) => (
              <li key={r.id}>
                <button
                  type="button"
                  onClick={() => setRoleId(r.id)}
                  className={cx(
                    'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm',
                    r.id === current.id ? 'bg-slate-800 text-white' : 'text-slate-300 hover:bg-slate-800/60',
                  )}
                >
                  <span
                    className="size-2.5 shrink-0 rounded-full"
                    style={{ backgroundColor: roleColor(r.color) }}
                  />
                  <span className="min-w-0 flex-1 truncate">{r.name}</span>
                  {ruleCounts.get(r.id) ? <Badge tone="blue">{ruleCounts.get(r.id)}</Badge> : null}
                </button>
              </li>
            ))}
          </ul>
        </Card>

        <div className="space-y-4">
          <Card
            title={
              <span className="flex items-center gap-2 normal-case">
                <span className="size-3 rounded-full" style={{ backgroundColor: roleColor(current.color) }} />
                {current.name}
              </span>
            }
            actions={!editable && <Badge tone="yellow">Read only (needs config:permset)</Badge>}
          >
            <div className="space-y-5">
              {ordered.map(([cat, nodes]) => (
                <section key={cat}>
                  <h3 className="mb-2 text-xs font-semibold tracking-wide text-slate-500 uppercase">
                    {cat === '*' ? 'Everything' : (CATEGORY_TITLES[cat] ?? cat)}
                  </h3>
                  <ul className="divide-y divide-slate-800/70">
                    {[...nodes]
                      .sort((a, b) =>
                        a.node.endsWith('*') ? -1 : b.node.endsWith('*') ? 1 : a.node.localeCompare(b.node),
                      )
                      .map((n) => {
                        const value = rulesFor.has(n.node) ? rulesFor.get(n.node)! : null;
                        return (
                          <li key={n.node} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
                            <div className="min-w-0 flex-1">
                              <code
                                className={cx(
                                  'text-sm',
                                  n.node.endsWith('*') ? 'font-semibold text-slate-100' : 'text-slate-200',
                                )}
                              >
                                {n.node}
                              </code>
                              <div className="truncate text-xs text-slate-500">{n.description}</div>
                            </div>
                            <TriState
                              label={`${n.node} for ${current.name}`}
                              value={value}
                              disabled={!editable || set.isPending}
                              onChange={(v) => set.mutate({ roleId: current.id, node: n.node, value: v })}
                            />
                          </li>
                        );
                      })}
                  </ul>
                </section>
              ))}
            </div>
          </Card>
          {can('config:permcheck') && (
            <CheckTool nodes={d.nodes.map((n) => n.node).filter((n) => n !== '*' && !n.endsWith(':*'))} />
          )}
        </div>
      </div>
    </>
  );
}
