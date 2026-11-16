import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import type { SyncSummaryDto, TierDto, TiersResponse } from '../../../src/shared/api.js';
import { api } from '../api.js';
import { PageHeader } from '../components/Layout.js';
import { RoleSelect, useRoles } from '../components/pickers.js';
import { SettingsCard, Toggle } from '../components/SettingsForm.js';
import {
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
  useToast,
} from '../components/ui.js';
import { number, relativeTime, roleColor } from '../format.js';

function TierDialog({ tier, onClose }: { tier: TierDto | 'new'; onClose: () => void }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const existing = tier === 'new' ? null : tier;
  const [name, setName] = useState(existing?.name ?? '');
  const [roleId, setRoleId] = useState(existing?.roleId ?? '');
  const [minTenureDays, setTenure] = useState(String(existing?.minTenureDays ?? 0));
  const [minActivity, setActivity] = useState(String(existing?.minActivity ?? 0));
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () => {
      const body = { name, roleId, minTenureDays: Number(minTenureDays), minActivity: Number(minActivity) };
      return existing
        ? api(`/tiers/${existing.id}`, { method: 'PATCH', body })
        : api('/tiers', { method: 'POST', body });
    },
    onSuccess: () => {
      toast(existing ? 'Tier updated.' : 'Tier added. Run a sync to apply it.');
      void queryClient.invalidateQueries({ queryKey: ['tiers'] });
      onClose();
    },
    onError: (e: Error) => setError(e.message),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    save.mutate();
  };
  return (
    <Modal open title={existing ? `Edit ${existing.name}` : 'Add a tier'} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <Field label="Name">
          <Input value={name} onChange={(e) => setName(e.target.value)} required maxLength={50} />
        </Field>
        <Field label="Role" hint="The bot's role must be above it.">
          <RoleSelect value={roleId} onChange={setRoleId} required />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Minimum tenure (days)" hint="0 = activity only">
            <Input
              type="number"
              min={0}
              step={1}
              value={minTenureDays}
              onChange={(e) => setTenure(e.target.value)}
              required
            />
          </Field>
          <Field label="Minimum activity" hint="Over the rolling window. 0 = tenure only">
            <Input
              type="number"
              min={0}
              step="any"
              value={minActivity}
              onChange={(e) => setActivity(e.target.value)}
              required
            />
          </Field>
        </div>
        {error && (
          <p className="rounded-md border border-red-500/30 bg-red-500/10 p-2 text-sm text-red-200">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={save.isPending}>
            {existing ? 'Save' : 'Add tier'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function SyncLine({ label, s }: { label: string; s: SyncSummaryDto | null }) {
  return (
    <div className="text-sm">
      <span className="text-slate-400">{label}: </span>
      {s ? (
        <>
          {relativeTime(s.at)}, {s.changed} changed of {s.members}
          {s.skipped ? `, ${s.skipped} skipped` : ''}
          {s.errors ? `, ${s.errors} errors` : ''}
        </>
      ) : (
        'never'
      )}
    </div>
  );
}

type TierSettings = {
  mode: string;
  demotion: boolean;
  demotionGraceDays: number;
  demotionFloorTierId: number | null;
  syncIntervalMinutes: number;
  excludedRoleIds: string[];
};

export function TiersPage() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const roles = useRoles();
  const [editing, setEditing] = useState<TierDto | 'new' | null>(null);
  const q = useQuery({ queryKey: ['tiers'], queryFn: () => api<TiersResponse>('/tiers') });
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['tiers'] });

  const reorder = useMutation({
    mutationFn: (ids: number[]) => api('/tiers/reorder', { method: 'POST', body: { ids } }),
    onSuccess: invalidate,
    onError: (e: Error) => toast(e.message, 'error'),
  });
  const remove = useMutation({
    mutationFn: (id: number) => api(`/tiers/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      toast('Tier removed. Members keep its role until you remove it.');
      void invalidate();
    },
    onError: (e: Error) => toast(e.message, 'error'),
  });
  const sync = useMutation({
    mutationFn: (tenureOnly: boolean) =>
      api<SyncSummaryDto>('/tiers/sync', { method: 'POST', body: { tenureOnly } }),
    onSuccess: (s) => {
      toast(
        `${s.basis === 'tenure' ? 'Tenure placement' : 'Sync'} done: ${s.changed} of ${s.members} changed.`,
      );
      void invalidate();
    },
    onError: (e: Error) => toast(e.message, 'error'),
  });

  if (q.isPending) return <FullPageSpinner />;
  if (q.error) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  const d = q.data;
  const ids = d.tiers.map((t) => t.id);
  const move = (index: number, delta: number) => {
    const next = [...ids];
    const [moved] = next.splice(index, 1);
    next.splice(index + delta, 0, moved!);
    reorder.mutate(next);
  };

  return (
    <>
      <PageHeader
        title="Tiers"
        subtitle={`Up to ${d.maxTiers} tiers. Members earn a tier when they meet both its tenure and its activity requirement. Position 1 is the lowest.`}
        actions={d.tiers.length < d.maxTiers && <Button onClick={() => setEditing('new')}>Add tier</Button>}
      />

      {d.issues.length > 0 && (
        <div
          role="alert"
          className="mb-4 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-100"
        >
          <div className="font-semibold">Configuration problems</div>
          <ul className="mt-1 list-disc pl-5">
            {d.issues.map((i) => (
              <li key={i}>{i.replace(/\*\*/g, '')}</li>
            ))}
          </ul>
        </div>
      )}

      <Card>
        {d.tiers.length === 0 ? (
          <EmptyState>No tiers yet.</EmptyState>
        ) : (
          <div className="-mx-4 overflow-x-auto sm:mx-0">
            <table className="w-full min-w-[680px] text-left text-sm">
              <thead className="text-xs text-slate-500 uppercase">
                <tr className="border-b border-slate-800">
                  <th className="px-3 py-2 font-medium">#</th>
                  <th className="px-3 py-2 font-medium">Tier</th>
                  <th className="px-3 py-2 font-medium">Tenure</th>
                  <th className="px-3 py-2 font-medium">Activity</th>
                  <th className="px-3 py-2 font-medium">Members</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                  <th className="px-3 py-2 font-medium" />
                </tr>
              </thead>
              <tbody>
                {d.tiers.map((t, i) => (
                  <tr key={t.id} className="border-b border-slate-800/60 last:border-0">
                    <td className="px-3 py-2 font-mono text-slate-400">{t.position}</td>
                    <td className="px-3 py-2">
                      <div className="font-medium text-slate-100">{t.name}</div>
                      <div className="flex items-center gap-1.5 text-xs text-slate-400">
                        <span
                          className="size-2 rounded-full"
                          style={{ backgroundColor: roleColor(t.roleColor) }}
                        />
                        @{t.roleName ?? 'deleted role'}
                      </div>
                    </td>
                    <td className="px-3 py-2">{t.minTenureDays ? `≥ ${number(t.minTenureDays)} d` : '—'}</td>
                    <td className="px-3 py-2">{t.minActivity ? `≥ ${number(t.minActivity)}` : '—'}</td>
                    <td className="px-3 py-2">{number(t.members)}</td>
                    <td className="px-3 py-2">
                      {t.manageable ? <Badge tone="green">OK</Badge> : <Badge tone="red">{t.problem}</Badge>}
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex justify-end gap-1">
                        <Button
                          size="sm"
                          variant="ghost"
                          aria-label={`Move ${t.name} down`}
                          disabled={i === 0 || reorder.isPending}
                          onClick={() => move(i, -1)}
                        >
                          ↓
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          aria-label={`Move ${t.name} up`}
                          disabled={i === d.tiers.length - 1 || reorder.isPending}
                          onClick={() => move(i, 1)}
                        >
                          ↑
                        </Button>
                        <Button size="sm" variant="secondary" onClick={() => setEditing(t)}>
                          Edit
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="text-red-300"
                          onClick={() =>
                            window.confirm(`Delete the ${t.name} tier? Members keep its role.`) &&
                            remove.mutate(t.id)
                          }
                        >
                          Delete
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card title="Sync">
          <div className="space-y-1">
            <SyncLine label="Last sync" s={d.lastSync} />
            <SyncLine label="Last tenure placement" s={d.lastTenureSync} />
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            <Button
              loading={sync.isPending && sync.variables === false}
              disabled={sync.isPending || !d.tiers.length}
              onClick={() => sync.mutate(false)}
            >
              Sync now
            </Button>
            <Button
              variant="secondary"
              loading={sync.isPending && sync.variables === true}
              disabled={sync.isPending || !d.tiers.length}
              onClick={() =>
                window.confirm(
                  'Place every member in the tier their tenure earns, ignoring activity? This can move members up or down.',
                ) && sync.mutate(true)
              }
            >
              Tenure placement
            </Button>
          </div>
          <p className="mt-3 text-xs text-slate-500">
            “Sync now” applies tenure and activity, the same as <code>/tiers sync</code>. “Tenure placement”
            is <code>/tiers tenure-sync</code>.
          </p>
        </Card>

        <SettingsCard<TierSettings> section="tiers" title="Tier settings">
          {(s, set, disabled) => (
            <>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Mode">
                  <Select value={s.mode} disabled={disabled} onChange={(e) => set('mode', e.target.value)}>
                    <option value="highest_only">Highest only</option>
                    <option value="stack">Stack all</option>
                  </Select>
                </Field>
                <Field label="Sync every (minutes)">
                  <Input
                    type="number"
                    min={5}
                    max={1440}
                    disabled={disabled}
                    value={s.syncIntervalMinutes}
                    onChange={(e) => set('syncIntervalMinutes', Number(e.target.value))}
                  />
                </Field>
              </div>
              <Toggle
                label="Demotion"
                hint="Members who fall below a tier they hold step down one tier per grace period."
                checked={s.demotion}
                disabled={disabled}
                onChange={(v) => set('demotion', v)}
              />
              <div className="grid grid-cols-2 gap-3">
                <Field label="Grace period (days)">
                  <Input
                    type="number"
                    min={0}
                    max={90}
                    disabled={disabled || !s.demotion}
                    value={s.demotionGraceDays}
                    onChange={(e) => set('demotionGraceDays', Number(e.target.value))}
                  />
                </Field>
                <Field label="Demotion floor" hint="Never demote below this tier while its tenure is met.">
                  <Select
                    value={s.demotionFloorTierId ?? ''}
                    disabled={disabled}
                    onChange={(e) =>
                      set('demotionFloorTierId', e.target.value ? Number(e.target.value) : null)
                    }
                  >
                    <option value="">No floor</option>
                    {d.tiers.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>
              <Field label="Excluded roles" hint="Members with any of these roles are skipped (e.g. staff).">
                <div className="flex flex-wrap gap-1.5">
                  {s.excludedRoleIds.map((id) => {
                    const r = roles.data?.find((x) => x.id === id);
                    return (
                      <span
                        key={id}
                        className="inline-flex items-center gap-1 rounded-full border border-slate-700 bg-slate-800/60 py-0.5 pr-1 pl-2 text-xs"
                      >
                        {r?.name ?? id}
                        {!disabled && (
                          <button
                            type="button"
                            aria-label={`Stop excluding ${r?.name ?? id}`}
                            className="rounded-full px-1 text-slate-400 hover:text-red-300"
                            onClick={() =>
                              set(
                                'excludedRoleIds',
                                s.excludedRoleIds.filter((x) => x !== id),
                              )
                            }
                          >
                            ×
                          </button>
                        )}
                      </span>
                    );
                  })}
                  {!s.excludedRoleIds.length && <span className="text-xs text-slate-500">None</span>}
                </div>
                {!disabled && (
                  <div className="mt-2">
                    <RoleSelect
                      value=""
                      placeholder="Add an excluded role…"
                      onChange={(v) =>
                        v &&
                        !s.excludedRoleIds.includes(v) &&
                        set('excludedRoleIds', [...s.excludedRoleIds, v])
                      }
                    />
                  </div>
                )}
              </Field>
            </>
          )}
        </SettingsCard>
      </div>

      {editing && <TierDialog tier={editing} onClose={() => setEditing(null)} />}
    </>
  );
}
