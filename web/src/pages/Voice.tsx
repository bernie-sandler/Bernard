import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { Link } from 'react-router';
import type { HubDto, VoiceResponse } from '../../../src/shared/api.js';
import { api } from '../api.js';
import { PageHeader } from '../components/Layout.js';
import { ChannelSelect } from '../components/pickers.js';
import { SettingsCard, Toggle } from '../components/SettingsForm.js';
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
  useToast,
} from '../components/ui.js';

function HubDialog({ hub, onClose }: { hub: HubDto | 'new'; onClose: () => void }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const existing = hub === 'new' ? null : hub;
  const [channelId, setChannel] = useState(existing?.channelId ?? '');
  const [type, setType] = useState<'public' | 'private'>(existing?.type ?? 'public');
  const [categoryId, setCategory] = useState(existing?.categoryId ?? '');
  const [nameTemplate, setTemplate] = useState(existing?.nameTemplate ?? "{user}'s Channel");
  const [defaultLimit, setLimit] = useState(String(existing?.defaultLimit ?? 0));
  const [hide, setHide] = useState(existing?.hideFromEveryone ?? false);
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () => {
      const body = {
        type,
        categoryId,
        nameTemplate,
        defaultLimit: Number(defaultLimit),
        hideFromEveryone: type === 'private' && hide,
      };
      return existing
        ? api(`/voice/hubs/${existing.channelId}`, { method: 'PATCH', body })
        : api('/voice/hubs', { method: 'POST', body: { channelId, ...body } });
    },
    onSuccess: () => {
      toast(existing ? 'Hub updated.' : 'Hub created.');
      void queryClient.invalidateQueries({ queryKey: ['voice'] });
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
    <Modal open title={existing ? `Edit hub ${existing.channelName ?? ''}` : 'Add a hub'} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        {!existing && (
          <Field label="Hub voice channel" hint="Members join this channel to get their own.">
            <ChannelSelect value={channelId} onChange={setChannel} kinds={['voice']} required />
          </Field>
        )}
        <div className="grid grid-cols-2 gap-3">
          <Field label="Type">
            <Select value={type} onChange={(e) => setType(e.target.value as 'public' | 'private')}>
              <option value="public">Public: anyone can join</option>
              <option value="private">Private: invite only</option>
            </Select>
          </Field>
          <Field label="Category">
            <ChannelSelect value={categoryId} onChange={setCategory} kinds={['category']} required />
          </Field>
        </div>
        <div className="grid grid-cols-[1fr_7rem] gap-3">
          <Field label="Name template" hint="{user}, {username}, {count}">
            <Input
              value={nameTemplate}
              onChange={(e) => setTemplate(e.target.value)}
              required
              maxLength={100}
            />
          </Field>
          <Field label="User limit" hint="0 = none">
            <Input
              type="number"
              min={0}
              max={99}
              value={defaultLimit}
              onChange={(e) => setLimit(e.target.value)}
            />
          </Field>
        </div>
        {type === 'private' && (
          <Toggle
            label="Hide private channels from @everyone"
            hint="Otherwise they're visible but locked."
            checked={hide}
            onChange={setHide}
          />
        )}
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
            {existing ? 'Save' : 'Add hub'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

type VoiceSettings = { graceSeconds: number; hubCooldownSeconds: number; ownerLeaveMode: string };

export function VoicePage() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [editing, setEditing] = useState<HubDto | 'new' | null>(null);
  const q = useQuery({
    queryKey: ['voice'],
    queryFn: () => api<VoiceResponse>('/voice'),
    refetchInterval: 60_000,
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/voice/hubs/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      toast('Hub removed. Existing channels stay until they empty.');
      void queryClient.invalidateQueries({ queryKey: ['voice'] });
    },
    onError: (e: Error) => toast(e.message, 'error'),
  });

  if (q.isPending) return <FullPageSpinner />;
  if (q.error) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  const d = q.data;

  return (
    <>
      <PageHeader
        title="Voice hubs"
        subtitle="Join-to-create: joining a hub creates a temporary channel owned by that member."
        actions={<Button onClick={() => setEditing('new')}>Add hub</Button>}
      />
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Hubs">
          {d.hubs.length === 0 ? (
            <EmptyState>No hubs yet.</EmptyState>
          ) : (
            <ul className="space-y-3">
              {d.hubs.map((h) => (
                <li key={h.channelId} className="rounded-lg border border-slate-800 p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 font-medium">
                        🔊 {h.channelName ?? <span className="text-red-300">deleted channel</span>}
                        <Badge tone={h.type === 'private' ? 'yellow' : 'green'}>{h.type}</Badge>
                        {h.hideFromEveryone && <Badge>hidden</Badge>}
                      </div>
                      <div className="mt-1 text-xs text-slate-400">
                        Creates “{h.nameTemplate}” in 📁 {h.categoryName ?? 'missing category'}
                        {h.defaultLimit ? ` · limit ${h.defaultLimit}` : ''}
                      </div>
                    </div>
                    <div className="flex gap-1">
                      <Button size="sm" variant="secondary" onClick={() => setEditing(h)}>
                        Edit
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-red-300"
                        onClick={() =>
                          window.confirm(`Stop ${h.channelName ?? 'this channel'} being a hub?`) &&
                          remove.mutate(h.channelId)
                        }
                      >
                        Remove
                      </Button>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title={`Active channels (${d.active.length})`}>
          {d.active.length === 0 ? (
            <EmptyState>No temporary channels right now.</EmptyState>
          ) : (
            <ul className="space-y-3">
              {d.active.map((a) => (
                <li key={a.channelId} className="rounded-lg border border-slate-800 p-3">
                  <div className="flex items-center justify-between text-sm">
                    <span className="font-medium">🔊 {a.name}</span>
                    <span className="text-xs text-slate-500">
                      {a.owner ? `owner ${a.owner.name}` : 'no owner'}
                    </span>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {a.members.map((m) => (
                      <Link
                        key={m.id}
                        to={`/members/${m.id}`}
                        className="flex items-center gap-1.5 rounded-full bg-slate-800 py-0.5 pr-2.5 pl-0.5 text-xs hover:bg-slate-700"
                      >
                        <Avatar url={m.avatarUrl} name={m.name} size={20} />
                        {m.name}
                      </Link>
                    ))}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <SettingsCard<VoiceSettings> section="voice" title="Voice settings">
          {(s, set, disabled) => (
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Delete empty after (s)" hint="0–300">
                <Input
                  type="number"
                  min={0}
                  max={300}
                  disabled={disabled}
                  value={s.graceSeconds}
                  onChange={(e) => set('graceSeconds', Number(e.target.value))}
                />
              </Field>
              <Field label="Creation cooldown (s)" hint="Per member, 0–3600">
                <Input
                  type="number"
                  min={0}
                  max={3600}
                  disabled={disabled}
                  value={s.hubCooldownSeconds}
                  onChange={(e) => set('hubCooldownSeconds', Number(e.target.value))}
                />
              </Field>
              <Field
                label="When the owner leaves"
                hint="Transfer to whoever's been there longest, or let anyone /vc claim it"
              >
                <Select
                  value={s.ownerLeaveMode}
                  disabled={disabled}
                  onChange={(e) => set('ownerLeaveMode', e.target.value)}
                >
                  <option value="transfer">Transfer</option>
                  <option value="claim">Claim</option>
                </Select>
              </Field>
            </div>
          )}
        </SettingsCard>
      </div>
      {editing && <HubDialog hub={editing} onClose={() => setEditing(null)} />}
    </>
  );
}
