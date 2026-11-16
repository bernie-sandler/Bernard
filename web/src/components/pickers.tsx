import { useQuery } from '@tanstack/react-query';
import { useEffect, useId, useState } from 'react';
import type { ChannelDto, MemberListResponse, RoleDto } from '../../../src/shared/api.js';
import { api, qs } from '../api.js';
import { roleColor } from '../format.js';
import { Avatar, cx, Input, Select } from './ui.js';

export const useRoles = () =>
  useQuery({ queryKey: ['roles'], queryFn: () => api<RoleDto[]>('/roles'), staleTime: 60_000 });

export const useChannels = () =>
  useQuery({ queryKey: ['channels'], queryFn: () => api<ChannelDto[]>('/channels'), staleTime: 60_000 });

/** Role dropdown. `includeEveryone` adds @everyone (whose ID is the guild ID). */
export function RoleSelect({
  value,
  onChange,
  required,
  includeEveryone,
  everyoneId,
  placeholder = 'Choose a role…',
  id,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  required?: boolean;
  disabled?: boolean;
  includeEveryone?: boolean;
  everyoneId?: string;
  placeholder?: string;
  id?: string;
}) {
  const roles = useRoles();
  return (
    <Select
      id={id}
      value={value}
      required={required}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="">{roles.isPending ? 'Loading roles…' : placeholder}</option>
      {includeEveryone && everyoneId && <option value={everyoneId}>@everyone</option>}
      {(roles.data ?? []).map((r) => (
        <option key={r.id} value={r.id} style={{ color: roleColor(r.color) }}>
          {r.name}
          {r.managed ? ' (managed)' : ''}
        </option>
      ))}
    </Select>
  );
}

const KIND_ICON: Record<string, string> = {
  voice: '🔊',
  stage: '🎙',
  category: '📁',
  forum: '💬',
  announcement: '📣',
};

/** Channel dropdown grouped by category, optionally limited to some channel kinds. */
export function ChannelSelect({
  value,
  onChange,
  kinds,
  required,
  placeholder = 'Choose a channel…',
  id,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  kinds?: string[];
  required?: boolean;
  disabled?: boolean;
  placeholder?: string;
  id?: string;
}) {
  const channels = useChannels();
  const all = channels.data ?? [];
  const names = new Map(all.map((c) => [c.id, c.name]));
  const usable = all.filter((c) => !kinds || kinds.includes(c.kind));
  const groups = new Map<string, ChannelDto[]>();
  for (const c of usable) {
    const g = c.kind === 'category' ? '' : (c.parentId ?? '');
    groups.set(g, [...(groups.get(g) ?? []), c]);
  }
  const label = (c: ChannelDto) => `${KIND_ICON[c.kind] ?? '#'} ${c.name}`;
  return (
    <Select
      id={id}
      value={value}
      required={required}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="">{channels.isPending ? 'Loading channels…' : placeholder}</option>
      {[...groups.entries()].map(([parent, list]) =>
        parent ? (
          <optgroup key={parent} label={names.get(parent) ?? 'Category'}>
            {list.map((c) => (
              <option key={c.id} value={c.id}>
                {label(c)}
              </option>
            ))}
          </optgroup>
        ) : (
          list.map((c) => (
            <option key={c.id} value={c.id}>
              {label(c)}
            </option>
          ))
        ),
      )}
    </Select>
  );
}

/** Member search box. Accepts a picked result or a pasted user ID. */
export function MemberPicker({
  value,
  onChange,
  required,
  id,
}: {
  value: string;
  onChange: (v: string) => void;
  required?: boolean;
  id?: string;
}) {
  const listId = useId();
  const [text, setText] = useState('');
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<{ name: string; avatarUrl: string | null } | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setSearch(text.trim()), 250);
    return () => clearTimeout(t);
  }, [text]);
  useEffect(() => {
    if (!value) setPicked(null);
  }, [value]);

  const results = useQuery({
    queryKey: ['member-search', search],
    queryFn: () => api<MemberListResponse>(`/members${qs({ search, pageSize: 8, sort: 'name' })}`),
    enabled: search.length >= 2 && !/^\d{17,20}$/.test(search),
  });

  if (value && picked) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-slate-700 bg-slate-950 px-2 py-1.5">
        <Avatar url={picked.avatarUrl} name={picked.name} size={24} />
        <span className="min-w-0 flex-1 truncate text-sm">{picked.name}</span>
        <button
          type="button"
          className="rounded px-1.5 text-slate-400 hover:bg-slate-800 hover:text-slate-200"
          aria-label="Clear member"
          onClick={() => {
            onChange('');
            setText('');
          }}
        >
          ×
        </button>
      </div>
    );
  }

  return (
    <div className="relative">
      <Input
        id={id}
        value={text}
        required={required && !value}
        placeholder="Search members or paste an ID"
        autoComplete="off"
        aria-expanded={open}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onChange={(e) => {
          const v = e.target.value;
          setText(v);
          // A pasted ID is used as-is.
          onChange(/^\d{17,20}$/.test(v.trim()) ? v.trim() : '');
        }}
      />
      {open && results.data && results.data.items.length > 0 && (
        <ul
          id={listId}
          aria-label="Matching members"
          className="absolute z-20 mt-1 max-h-64 w-full overflow-auto rounded-md border border-slate-700 bg-slate-900 py-1 shadow-xl"
        >
          {results.data.items.map((m) => (
            <li key={m.userId}>
              <button
                type="button"
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-slate-800"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  setPicked({ name: m.displayName, avatarUrl: m.avatarUrl });
                  onChange(m.userId);
                  setOpen(false);
                }}
              >
                <Avatar url={m.avatarUrl} name={m.displayName} size={22} />
                <span className="truncate">{m.displayName}</span>
                <span className="truncate text-xs text-slate-500">@{m.username}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {value && !picked && <p className="mt-1 text-xs text-slate-500">Using ID {value}</p>}
    </div>
  );
}

/** Text input with suggestions from a command's autocomplete handler. */
export function AutocompleteInput({
  command,
  option,
  value,
  onChange,
  required,
  id,
}: {
  command: string;
  option: string;
  value: string;
  onChange: (v: string) => void;
  required?: boolean;
  id?: string;
}) {
  const [query, setQuery] = useState(value);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setQuery(value), 200);
    return () => clearTimeout(t);
  }, [value]);
  const choices = useQuery({
    queryKey: ['autocomplete', command, option, query],
    queryFn: () =>
      api<{ name: string; value: string }[]>(`/commands/autocomplete${qs({ command, option, q: query })}`),
    enabled: open,
  });
  return (
    <div className="relative">
      <Input
        id={id}
        value={value}
        required={required}
        autoComplete="off"
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onChange={(e) => onChange(e.target.value)}
      />
      {open && (choices.data?.length ?? 0) > 0 && (
        <ul className="absolute z-20 mt-1 max-h-64 w-full overflow-auto rounded-md border border-slate-700 bg-slate-900 py-1 shadow-xl">
          {choices.data!.map((c) => (
            <li key={c.value}>
              <button
                type="button"
                className={cx(
                  'block w-full truncate px-3 py-1.5 text-left text-sm hover:bg-slate-800',
                  c.value === value && 'text-indigo-300',
                )}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  onChange(c.value);
                  setOpen(false);
                }}
              >
                {c.name}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
