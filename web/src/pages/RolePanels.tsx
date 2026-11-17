import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import type {
  PanelRoleDto,
  RolePanelDto,
  RolePanelOptionDto,
  RolePanelsResponse,
} from '../../../src/shared/api.js';
import { api } from '../api.js';
import { PageHeader } from '../components/Layout.js';
import { ChannelSelect } from '../components/pickers.js';
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
  Textarea,
  useToast,
} from '../components/ui.js';
import { roleColor } from '../format.js';

const MAX_OPTIONS = 25;

type Draft = Omit<RolePanelDto, 'id' | 'channelId' | 'channelName'>;

const emptyDraft = (): Draft => ({
  title: '',
  description: '',
  style: 'buttons',
  mode: 'multi',
  options: [],
});

function PanelDialog({
  panel,
  roles,
  onClose,
}: {
  panel: RolePanelDto | 'new';
  roles: PanelRoleDto[];
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const existing = panel === 'new' ? null : panel;
  const [draft, setDraft] = useState<Draft>(
    existing
      ? {
          title: existing.title,
          description: existing.description,
          style: existing.style,
          mode: existing.mode,
          options: existing.options.map((o) => ({ ...o })),
        }
      : emptyDraft(),
  );
  const [pick, setPick] = useState('');
  const [error, setError] = useState<string | null>(null);
  const byId = new Map(roles.map((r) => [r.id, r]));
  const used = new Set(draft.options.map((o) => o.roleId));

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft((d) => ({ ...d, [k]: v }));
  const setOption = (i: number, patch: Partial<RolePanelOptionDto>) =>
    set(
      'options',
      draft.options.map((o, j) => (i === j ? { ...o, ...patch } : o)),
    );
  const move = (i: number, by: -1 | 1) => {
    const next = [...draft.options];
    const [o] = next.splice(i, 1);
    next.splice(i + by, 0, o!);
    set('options', next);
  };
  const addRole = (roleId: string) => {
    const r = byId.get(roleId);
    if (!r) return;
    set('options', [
      ...draft.options,
      { roleId, label: r.name.slice(0, 80), emoji: null, description: null },
    ]);
    setPick('');
  };

  const save = useMutation({
    mutationFn: () =>
      existing
        ? api<RolePanelDto>(`/role-panels/${existing.id}`, { method: 'PATCH', body: draft })
        : api<RolePanelDto>('/role-panels', { method: 'POST', body: draft }),
    onSuccess: () => {
      toast(existing?.channelId ? 'Panel saved and its message updated.' : 'Panel saved.');
      void queryClient.invalidateQueries({ queryKey: ['rolePanels'] });
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
    <Modal open wide title={existing ? `Edit “${existing.title}”` : 'New role panel'} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <Field label="Title">
          <Input
            value={draft.title}
            onChange={(e) => set('title', e.target.value)}
            required
            maxLength={100}
            placeholder="Pick your games"
          />
        </Field>
        <Field label="Description" hint="Shown above the roles. Optional.">
          <Textarea
            rows={2}
            value={draft.description}
            onChange={(e) => set('description', e.target.value)}
            maxLength={1000}
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Style">
            <Select value={draft.style} onChange={(e) => set('style', e.target.value as Draft['style'])}>
              <option value="buttons">Buttons: click to toggle</option>
              <option value="select">Menu: pick from a dropdown</option>
            </Select>
          </Field>
          <Field label="Mode">
            <Select value={draft.mode} onChange={(e) => set('mode', e.target.value as Draft['mode'])}>
              <option value="multi">Any number of roles</option>
              <option value="single">Only one role</option>
            </Select>
          </Field>
        </div>

        <div>
          <div className="mb-1.5 text-sm font-medium text-slate-300">Roles</div>
          {draft.options.length === 0 && (
            <p className="mb-2 text-sm text-slate-500">Add the roles members can pick.</p>
          )}
          <ul className="space-y-2">
            {draft.options.map((o, i) => {
              const r = byId.get(o.roleId);
              return (
                <li key={o.roleId} className="rounded-lg border border-slate-800 p-2">
                  <div className="mb-2 flex items-center justify-between gap-2 text-sm">
                    <span style={{ color: roleColor(r?.color ?? 0) }}>@{r?.name ?? 'deleted role'}</span>
                    <div className="flex gap-1">
                      <Button size="sm" variant="ghost" disabled={i === 0} onClick={() => move(i, -1)}>
                        ↑
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={i === draft.options.length - 1}
                        onClick={() => move(i, 1)}
                      >
                        ↓
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-red-300"
                        onClick={() =>
                          set(
                            'options',
                            draft.options.filter((_, j) => j !== i),
                          )
                        }
                      >
                        Remove
                      </Button>
                    </div>
                  </div>
                  {r?.problem && <p className="mb-2 text-xs text-red-300">Can't be offered: {r.problem}.</p>}
                  <div className="grid grid-cols-[1fr_5rem] gap-2 sm:grid-cols-[1fr_5rem_1.5fr]">
                    <Input
                      aria-label="Label"
                      value={o.label}
                      onChange={(e) => setOption(i, { label: e.target.value })}
                      required
                      maxLength={80}
                      placeholder="Label"
                    />
                    <Input
                      aria-label="Emoji"
                      value={o.emoji ?? ''}
                      onChange={(e) => setOption(i, { emoji: e.target.value || null })}
                      maxLength={64}
                      placeholder="🎮"
                    />
                    <Input
                      aria-label="Description"
                      className="col-span-2 sm:col-span-1"
                      value={o.description ?? ''}
                      onChange={(e) => setOption(i, { description: e.target.value || null })}
                      maxLength={100}
                      placeholder="Description (optional)"
                    />
                  </div>
                </li>
              );
            })}
          </ul>
          {draft.options.length < MAX_OPTIONS && (
            <div className="mt-2">
              <Select aria-label="Add a role" value={pick} onChange={(e) => addRole(e.target.value)}>
                <option value="">+ Add a role…</option>
                {roles
                  .filter((r) => !used.has(r.id))
                  .map((r) => (
                    <option key={r.id} value={r.id} disabled={Boolean(r.problem)}>
                      {r.name}
                      {r.problem ? ` (${r.problem})` : ''}
                    </option>
                  ))}
              </Select>
              <p className="mt-1 text-xs text-slate-500">
                Roles with moderator permissions, managed roles and roles above Bernard's highest role can't
                be offered.
              </p>
            </div>
          )}
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
          <Button type="submit" loading={save.isPending} disabled={draft.options.length === 0}>
            {existing ? 'Save' : 'Create panel'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function PanelCard({
  panel,
  roles,
  onEdit,
}: {
  panel: RolePanelDto;
  roles: PanelRoleDto[];
  onEdit: () => void;
}) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [channelId, setChannel] = useState(panel.channelId ?? '');
  const byId = new Map(roles.map((r) => [r.id, r]));
  const done = (text: string) => () => {
    toast(text);
    void queryClient.invalidateQueries({ queryKey: ['rolePanels'] });
  };
  const fail = (e: Error) => {
    toast(e.message, 'error');
    void queryClient.invalidateQueries({ queryKey: ['rolePanels'] });
  };
  const post = useMutation({
    mutationFn: () => api(`/role-panels/${panel.id}/post`, { method: 'POST', body: { channelId } }),
    onSuccess: done('Panel posted.'),
    onError: fail,
  });
  const refresh = useMutation({
    mutationFn: () => api(`/role-panels/${panel.id}/refresh`, { method: 'POST' }),
    onSuccess: done('Panel message updated.'),
    onError: fail,
  });
  const remove = useMutation({
    mutationFn: () => api(`/role-panels/${panel.id}`, { method: 'DELETE' }),
    onSuccess: done('Panel deleted. Members keep their roles.'),
    onError: fail,
  });
  const problems = panel.options.filter((o) => byId.get(o.roleId)?.problem ?? !byId.has(o.roleId));

  return (
    <Card
      title={panel.title}
      actions={
        <div className="flex gap-1">
          <Badge tone="blue">{panel.style === 'buttons' ? 'Buttons' : 'Menu'}</Badge>
          <Badge>{panel.mode === 'single' ? 'Pick one' : 'Pick any'}</Badge>
        </div>
      }
    >
      <div className="space-y-3">
        {panel.description && (
          <p className="text-sm whitespace-pre-line text-slate-400">{panel.description}</p>
        )}
        <div className="flex flex-wrap gap-1.5">
          {panel.options.map((o) => {
            const r = byId.get(o.roleId);
            return (
              <span
                key={o.roleId}
                className="rounded-md bg-slate-800 px-2 py-1 text-xs"
                style={{ color: roleColor(r?.color ?? 0) }}
                title={r ? `@${r.name}` : 'deleted role'}
              >
                {o.emoji ? `${o.emoji} ` : ''}
                {o.label}
              </span>
            );
          })}
        </div>
        {problems.length > 0 && (
          <p className="rounded-md border border-amber-500/30 bg-amber-500/10 p-2 text-xs text-amber-200">
            {problems.length} role(s) can't be handed out any more. Edit the panel to fix them.
          </p>
        )}
        <div className="text-xs text-slate-500">
          {panel.channelId ? `Posted in #${panel.channelName ?? 'deleted channel'}` : 'Not posted yet'}
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-48 flex-1">
            <ChannelSelect value={channelId} onChange={setChannel} kinds={['text', 'announcement']} />
          </div>
          <Button
            onClick={() => post.mutate()}
            loading={post.isPending}
            disabled={!channelId || (channelId === panel.channelId && Boolean(panel.channelId))}
          >
            {panel.channelId ? 'Move' : 'Post'}
          </Button>
        </div>
        <div className="flex justify-end gap-1 border-t border-slate-800 pt-3">
          {panel.channelId && (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => refresh.mutate()}
              loading={refresh.isPending}
            >
              Update message
            </Button>
          )}
          <Button size="sm" variant="secondary" onClick={onEdit}>
            Edit
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="text-red-300"
            loading={remove.isPending}
            onClick={() =>
              window.confirm(`Delete “${panel.title}” and its message? Members keep their roles.`) &&
              remove.mutate()
            }
          >
            Delete
          </Button>
        </div>
      </div>
    </Card>
  );
}

export function RolePanelsPage() {
  const [editing, setEditing] = useState<RolePanelDto | 'new' | null>(null);
  const q = useQuery({ queryKey: ['rolePanels'], queryFn: () => api<RolePanelsResponse>('/role-panels') });

  if (q.isPending) return <FullPageSpinner />;
  if (q.error) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  const d = q.data;

  return (
    <>
      <PageHeader
        title="Role panels"
        subtitle="Messages with buttons or a menu that let members give themselves roles, like games or ping roles."
        actions={<Button onClick={() => setEditing('new')}>New panel</Button>}
      />
      {d.panels.length === 0 ? (
        <Card>
          <EmptyState>
            No panels yet. Create one for game roles, or ping roles like “MC updates” and “Movie night”.
          </EmptyState>
        </Card>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {d.panels.map((p) => (
            <PanelCard key={p.id} panel={p} roles={d.roles} onEdit={() => setEditing(p)} />
          ))}
        </div>
      )}
      {editing && <PanelDialog panel={editing} roles={d.roles} onClose={() => setEditing(null)} />}
    </>
  );
}
