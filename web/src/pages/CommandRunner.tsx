import { useMutation, useQuery } from '@tanstack/react-query';
import { type FormEvent, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import type { CommandDto, CommandOptionDto, RunCommandResponse } from '../../../src/shared/api.js';
import { api } from '../api.js';
import { useAuth } from '../auth.js';
import { PageHeader } from '../components/Layout.js';
import { AutocompleteInput, ChannelSelect, MemberPicker, RoleSelect } from '../components/pickers.js';
import { ResultView } from '../components/ResultView.js';
import {
  Badge,
  type BadgeTone,
  Button,
  Card,
  cx,
  EmptyState,
  ErrorBox,
  Field,
  Input,
  Select,
  Spinner,
  Textarea,
} from '../components/ui.js';

const CATEGORY_TITLES: Record<string, string> = {
  public: 'General',
  voice: 'Voice channels',
  admin: 'Moderation',
  config: 'Configuration',
};

const OUTCOME_TONES: Record<RunCommandResponse['outcome'], BadgeTone> = {
  ok: 'green',
  failed: 'yellow',
  invalid: 'yellow',
  denied: 'red',
  error: 'red',
};

function OptionField({
  command,
  option,
  value,
  onChange,
}: {
  command: string;
  option: CommandOptionDto;
  value: string;
  onChange: (v: string) => void;
}) {
  const id = `opt-${option.name}`;
  const label = `${option.name}${option.required ? '' : ' (optional)'}`;
  // Add examples/ranges only when the command's own description doesn't already give them.
  const hasExample = /e\.g\./i.test(option.description);
  const hasRange = /\d+\s*[-–]\s*\d+/.test(option.description);
  const hint =
    option.kind === 'duration' && !hasExample
      ? `${option.description} (e.g. 10m, 2h, 7d)`
      : (option.min !== undefined || option.max !== undefined) && !hasRange
        ? `${option.description} (${option.min ?? '…'}–${option.max ?? '…'})`
        : option.description;

  let control: React.ReactNode;
  if (option.choices?.length) {
    control = (
      <Select id={id} value={value} required={option.required} onChange={(e) => onChange(e.target.value)}>
        <option value="">{option.required ? 'Choose…' : '—'}</option>
        {option.choices.map((c) => (
          <option key={String(c.value)} value={String(c.value)}>
            {c.name}
          </option>
        ))}
      </Select>
    );
  } else if (option.kind === 'boolean') {
    control = (
      <Select id={id} value={value} required={option.required} onChange={(e) => onChange(e.target.value)}>
        <option value="">{option.required ? 'Choose…' : '—'}</option>
        <option value="true">Yes</option>
        <option value="false">No</option>
      </Select>
    );
  } else if (option.kind === 'user') {
    control = <MemberPicker id={id} value={value} onChange={onChange} required={option.required} />;
  } else if (option.kind === 'role') {
    control = <RoleSelect id={id} value={value} onChange={onChange} required={option.required} />;
  } else if (option.kind === 'channel') {
    control = (
      <ChannelSelect
        id={id}
        value={value}
        onChange={onChange}
        required={option.required}
        {...(option.channelTypes ? { kinds: option.channelTypes } : {})}
      />
    );
  } else if (option.kind === 'integer' || option.kind === 'number') {
    control = (
      <Input
        id={id}
        type="number"
        value={value}
        required={option.required}
        step={option.kind === 'integer' ? 1 : 'any'}
        {...(option.min !== undefined ? { min: option.min } : {})}
        {...(option.max !== undefined ? { max: option.max } : {})}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  } else if (option.autocomplete) {
    control = (
      <AutocompleteInput
        id={id}
        command={command}
        option={option.name}
        value={value}
        onChange={onChange}
        required={option.required}
      />
    );
  } else if (option.multiline) {
    control = (
      <Textarea
        id={id}
        value={value}
        required={option.required}
        {...(option.maxLength ? { maxLength: option.maxLength } : {})}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  } else {
    control = (
      <Input
        id={id}
        value={value}
        required={option.required}
        {...(option.maxLength ? { maxLength: option.maxLength } : {})}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  }
  return (
    <Field label={label} hint={hint}>
      {control}
    </Field>
  );
}

function toInput(options: CommandOptionDto[], values: Record<string, string>): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  for (const o of options) {
    const v = values[o.name]?.trim();
    if (!v) continue;
    if (o.kind === 'integer' || o.kind === 'number') input[o.name] = Number(v);
    else if (o.kind === 'boolean') input[o.name] = v === 'true';
    else input[o.name] = v;
  }
  return input;
}

export function CommandRunnerPage() {
  const { me } = useAuth();
  const [params, setParams] = useSearchParams();
  const selected = params.get('c') ?? '';
  const [filter, setFilter] = useState('');
  const [values, setValues] = useState<Record<string, string>>({});

  const commands = useQuery({ queryKey: ['commands'], queryFn: () => api<CommandDto[]>('/commands') });
  const command = commands.data?.find((c) => c.fullName === selected);

  const run = useMutation({
    mutationFn: (body: { command: string; input: Record<string, unknown> }) =>
      api<RunCommandResponse>('/commands/run', { method: 'POST', body }),
  });

  const grouped = useMemo(() => {
    const f = filter.trim().toLowerCase();
    const out = new Map<string, CommandDto[]>();
    for (const c of commands.data ?? []) {
      if (f && !c.fullName.includes(f) && !c.description.toLowerCase().includes(f)) continue;
      out.set(c.category, [...(out.get(c.category) ?? []), c]);
    }
    return out;
  }, [commands.data, filter]);

  const choose = (fullName: string) => {
    setValues({});
    run.reset();
    setParams({ c: fullName });
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!command) return;
    run.mutate({ command: command.fullName, input: toInput(command.options, values) });
  };

  return (
    <>
      <PageHeader
        title="Command Runner"
        subtitle="Run any command you're allowed to use. It runs exactly like the slash command and is logged with source “dashboard”."
      />
      {commands.error ? (
        <ErrorBox error={commands.error} onRetry={() => commands.refetch()} />
      ) : (
        <div className="grid gap-4 lg:grid-cols-[18rem_minmax(0,1fr)]">
          <Card className="lg:max-h-[calc(100vh-12rem)] lg:overflow-y-auto">
            <Input
              type="search"
              placeholder="Filter commands…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              aria-label="Filter commands"
            />
            {commands.isPending ? (
              <div className="flex justify-center py-6">
                <Spinner />
              </div>
            ) : grouped.size === 0 ? (
              <EmptyState>No commands match.</EmptyState>
            ) : (
              <nav className="mt-3 space-y-4">
                {[...grouped.entries()].map(([cat, list]) => (
                  <div key={cat}>
                    <div className="mb-1 px-2 text-xs font-semibold tracking-wide text-slate-500 uppercase">
                      {CATEGORY_TITLES[cat] ?? cat}
                    </div>
                    <ul>
                      {list.map((c) => (
                        <li key={c.fullName}>
                          <button
                            type="button"
                            onClick={() => choose(c.fullName)}
                            className={cx(
                              'w-full rounded-md px-2 py-1.5 text-left font-mono text-sm',
                              c.fullName === selected
                                ? 'bg-blurple/20 text-indigo-200'
                                : 'text-slate-300 hover:bg-slate-800',
                            )}
                          >
                            /{c.fullName}
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </nav>
            )}
          </Card>

          <div className="space-y-4">
            {!command ? (
              <Card>
                <EmptyState>
                  Pick a command on the left. You're running commands as {me.user.displayName}.
                </EmptyState>
              </Card>
            ) : (
              <Card
                title={<span className="font-mono normal-case">/{command.fullName}</span>}
                actions={<Badge>{command.node}</Badge>}
              >
                <p className="mb-4 text-sm text-slate-400">{command.description}</p>
                <form onSubmit={submit} className="space-y-4">
                  {command.options.length === 0 && (
                    <p className="text-sm text-slate-500">This command has no options.</p>
                  )}
                  <div className="grid gap-4 sm:grid-cols-2">
                    {command.options.map((o) => (
                      <div key={o.name} className={o.multiline ? 'sm:col-span-2' : ''}>
                        <OptionField
                          command={command.fullName}
                          option={o}
                          value={values[o.name] ?? ''}
                          onChange={(v) => setValues((s) => ({ ...s, [o.name]: v }))}
                        />
                      </div>
                    ))}
                  </div>
                  <div className="flex justify-end">
                    <Button type="submit" loading={run.isPending}>
                      Run /{command.fullName}
                    </Button>
                  </div>
                </form>
              </Card>
            )}

            {run.error && <ErrorBox error={run.error} />}
            {run.data && (
              <Card
                title="Result"
                actions={<Badge tone={OUTCOME_TONES[run.data.outcome]}>{run.data.outcome}</Badge>}
              >
                <ResultView result={run.data.result} mentions={run.data.mentions} />
              </Card>
            )}
          </div>
        </div>
      )}
    </>
  );
}
