import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, type ReactNode, useEffect, useState } from 'react';
import type { SettingsResponse, SettingsSection } from '../../../src/shared/api.js';
import { api } from '../api.js';
import { Badge, Button, Card, useToast } from './ui.js';

export const useSettings = () =>
  useQuery({ queryKey: ['settings'], queryFn: () => api<SettingsResponse>('/settings') });

export const SECTION_NODES: Record<SettingsSection, string> = {
  logs: 'config:logs',
  voice: 'config:voice',
  activity: 'config:activity',
  tenure: 'config:activity',
  tiers: 'config:tiers',
  moderation: 'config:settings',
  permissions: 'config:settings',
  thatsCrazy: 'config:settings',
};

/**
 * A card that edits one settings section. Keeps a local draft, saves only changed keys, and is
 * read-only when the user lacks the section's node.
 */
export function SettingsCard<T extends Record<string, unknown>>({
  section,
  title,
  description,
  children,
  extraSections,
}: {
  section: SettingsSection;
  title: string;
  description?: ReactNode;
  /** Render fields from the draft; call set(key, value) to change one. */
  children: (draft: T, set: (key: keyof T & string, value: unknown) => void, disabled: boolean) => ReactNode;
  /** Other sections saved together with this one (e.g. tenure with activity), keyed by their fields. */
  extraSections?: Partial<Record<SettingsSection, string[]>>;
}) {
  const settings = useSettings();
  const queryClient = useQueryClient();
  const toast = useToast();
  const original = settings.data?.settings[section] as T | undefined;
  const extras = Object.entries(extraSections ?? {}) as [SettingsSection, string[]][];
  const [draft, setDraft] = useState<T | null>(null);

  const merged = (): T | undefined => {
    if (!settings.data || !original) return undefined;
    const extraValues = Object.fromEntries(
      extras.flatMap(([s, keys]) => keys.map((k) => [k, settings.data!.settings[s][k]])),
    );
    return { ...original, ...extraValues } as T;
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset the draft when fresh settings arrive
  useEffect(() => {
    setDraft(merged() ?? null);
  }, [settings.data]);

  const save = useMutation({
    mutationFn: async (value: T) => {
      const base = merged()!;
      const extraKeys = new Set(extras.flatMap(([, keys]) => keys));
      const changed = Object.entries(value).filter(([k, v]) => JSON.stringify(v) !== JSON.stringify(base[k]));
      const main = Object.fromEntries(changed.filter(([k]) => !extraKeys.has(k)));
      if (Object.keys(main).length) await api(`/settings/${section}`, { method: 'PATCH', body: main });
      for (const [s, keys] of extras) {
        const part = Object.fromEntries(changed.filter(([k]) => keys.includes(k)));
        if (Object.keys(part).length) await api(`/settings/${s}`, { method: 'PATCH', body: part });
      }
      return changed.length;
    },
    onSuccess: (n) => {
      toast(n ? 'Settings saved.' : 'Nothing changed.');
      void queryClient.invalidateQueries({ queryKey: ['settings'] });
    },
    onError: (e: Error) => toast(e.message, 'error'),
  });

  if (!settings.data || !draft) return null;
  const editable = settings.data.editable[section] && extras.every(([s]) => settings.data!.editable[s]);
  const dirty = JSON.stringify(draft) !== JSON.stringify(merged());
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate(draft);
  };

  return (
    <Card
      title={title}
      actions={!editable && <Badge tone="yellow">Read only (needs {SECTION_NODES[section]})</Badge>}
    >
      {description && <p className="-mt-1 mb-4 text-sm text-slate-400">{description}</p>}
      <form onSubmit={submit} className="space-y-4">
        {children(draft, (k, v) => setDraft((d) => ({ ...(d as T), [k]: v })), !editable)}
        {editable && (
          <div className="flex justify-end gap-2">
            {dirty && (
              <Button variant="ghost" onClick={() => setDraft(merged() ?? null)}>
                Reset
              </Button>
            )}
            <Button type="submit" loading={save.isPending} disabled={!dirty}>
              Save
            </Button>
          </div>
        )}
      </form>
    </Card>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
  hint,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  hint?: ReactNode;
  disabled?: boolean;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-3">
      <input
        type="checkbox"
        className="mt-0.5 size-4 accent-blurple"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span>
        <span className="block text-sm text-slate-200">{label}</span>
        {hint && <span className="block text-xs text-slate-500">{hint}</span>}
      </span>
    </label>
  );
}
