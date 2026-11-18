import { RoleSelect, useRoles } from './pickers.js';
import { SettingsCard, Toggle } from './SettingsForm.js';
import { Button, Field, Input, Select, Textarea } from './ui.js';

const ACTIONS = [
  { value: 'mute', label: 'Mute' },
  { value: 'deafen', label: 'Deafen' },
  { value: 'disconnect', label: 'Disconnect' },
  { value: 'timeout', label: 'Timeout' },
] as const;

type Step = { action: (typeof ACTIONS)[number]['value']; minutes: number };

type ThatsCrazy = {
  enabled: boolean;
  pollSeconds: number;
  minVotes: number;
  voiceShare: number;
  strikeWindowDays: number;
  ladder: Step[];
  dmMessages: string[];
  targetCooldownMinutes: number;
  failedCooldownMinutes: number;
  starterCooldownMinutes: number;
  exemptRoleIds: string[];
};

const SUBHEADING = 'text-xs font-semibold tracking-wide text-slate-500 uppercase';

/** Settings card for /thatscrazy votes. */
export function ThatsCrazySettings() {
  const roles = useRoles();
  return (
    <SettingsCard<ThatsCrazy>
      section="thatsCrazy"
      title="That's crazy"
      description="/thatscrazy @member starts a quick vote. If it passes, the member gets the penalty for their strike number and a DM."
    >
      {(s, set, disabled) => {
        const num = (
          key: keyof ThatsCrazy & string,
          min: number,
          max: number,
          label: string,
          hint?: string,
        ) => (
          <Field label={label} hint={hint}>
            <Input
              type="number"
              min={min}
              max={max}
              disabled={disabled}
              value={s[key] as number}
              onChange={(e) => set(key, Number(e.target.value))}
            />
          </Field>
        );
        const setStep = (i: number, patch: Partial<Step>) =>
          set(
            'ladder',
            s.ladder.map((step, j) => (j === i ? { ...step, ...patch } : step)),
          );
        return (
          <>
            <Toggle
              label="Allow /thatscrazy votes"
              checked={s.enabled}
              disabled={disabled}
              onChange={(v) => set('enabled', v)}
            />

            <p className={SUBHEADING}>Votes</p>
            <div className="grid gap-3 sm:grid-cols-3">
              {num('pollSeconds', 15, 3600, 'Poll length (seconds)', '15–3600')}
              {num('minVotes', 1, 50, 'Votes needed at least', 'The starter counts')}
              <Field label="Share of voice channel" hint="% of the others in the target's channel">
                <Input
                  type="number"
                  min={0}
                  max={100}
                  disabled={disabled}
                  value={Math.round(s.voiceShare * 100)}
                  onChange={(e) => set('voiceShare', Number(e.target.value) / 100)}
                />
              </Field>
            </div>

            <p className={SUBHEADING}>Penalties</p>
            <Field
              label="Penalty for each strike"
              hint="Mute and deafen are server mutes. Disconnect keeps them out of voice until it ends. The last step repeats."
            >
              <div className="space-y-2">
                {s.ladder.map((step, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: steps have no identity besides their position
                  <div
                    key={i}
                    className="grid grid-cols-[3.5rem_minmax(0,1fr)_5rem_1.5rem_1rem] items-center gap-2"
                  >
                    <span className="text-xs text-slate-400">Strike {i + 1}</span>
                    <Select
                      value={step.action}
                      disabled={disabled}
                      onChange={(e) => setStep(i, { action: e.target.value as Step['action'] })}
                    >
                      {ACTIONS.map((a) => (
                        <option key={a.value} value={a.value}>
                          {a.label}
                        </option>
                      ))}
                    </Select>
                    <Input
                      type="number"
                      min={1}
                      max={40320}
                      aria-label={`Strike ${i + 1} minutes`}
                      disabled={disabled}
                      value={step.minutes}
                      onChange={(e) => setStep(i, { minutes: Number(e.target.value) })}
                    />
                    <span className="text-xs text-slate-400">min</span>
                    {!disabled && s.ladder.length > 1 && (
                      <button
                        type="button"
                        aria-label={`Remove strike ${i + 1}`}
                        className="px-1 text-slate-400 hover:text-red-300"
                        onClick={() =>
                          set(
                            'ladder',
                            s.ladder.filter((_, j) => j !== i),
                          )
                        }
                      >
                        ×
                      </button>
                    )}
                  </div>
                ))}
                {!disabled && s.ladder.length < 10 && (
                  <Button
                    variant="ghost"
                    onClick={() => {
                      const last = s.ladder.at(-1) ?? { action: 'mute', minutes: 1 };
                      set('ladder', [...s.ladder, { ...last, minutes: last.minutes * 2 }]);
                    }}
                  >
                    Add a step
                  </Button>
                )}
              </div>
            </Field>
            {num('strikeWindowDays', 1, 365, 'Strikes count for (days)', 'Older passed votes stop counting')}
            <Field
              label="DM for each strike"
              hint="One message per line; the last repeats. {count}, {action}, {minutes}, {server}. Empty = no DM."
            >
              <Textarea
                rows={4}
                disabled={disabled}
                value={s.dmMessages.join('\n')}
                onChange={(e) =>
                  set(
                    'dmMessages',
                    e.target.value.split('\n').filter((line, i, all) => line.trim() || i === all.length - 1),
                  )
                }
                onBlur={() => set('dmMessages', s.dmMessages.map((m) => m.trim()).filter(Boolean))}
              />
            </Field>

            <p className={SUBHEADING}>Abuse limits</p>
            <div className="grid gap-3 sm:grid-cols-3">
              {num('targetCooldownMinutes', 0, 1440, 'After a passed vote (min)', 'No new vote on them')}
              {num('failedCooldownMinutes', 0, 1440, 'After a failed vote (min)', 'No new vote on them')}
              {num('starterCooldownMinutes', 0, 1440, 'Between starts (min)', 'Per member')}
            </div>
            <Field
              label="Exempt roles"
              hint="Members with any of these can't be voted on. Bots and the owner never can."
            >
              <div className="flex flex-wrap gap-1.5">
                {s.exemptRoleIds.map((id) => {
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
                          aria-label={`Stop exempting ${r?.name ?? id}`}
                          className="rounded-full px-1 text-slate-400 hover:text-red-300"
                          onClick={() =>
                            set(
                              'exemptRoleIds',
                              s.exemptRoleIds.filter((x) => x !== id),
                            )
                          }
                        >
                          ×
                        </button>
                      )}
                    </span>
                  );
                })}
                {!s.exemptRoleIds.length && <span className="text-xs text-slate-500">None</span>}
              </div>
              {!disabled && (
                <div className="mt-2">
                  <RoleSelect
                    value=""
                    placeholder="Add an exempt role…"
                    onChange={(v) =>
                      v && !s.exemptRoleIds.includes(v) && set('exemptRoleIds', [...s.exemptRoleIds, v])
                    }
                  />
                </div>
              )}
            </Field>
          </>
        );
      }}
    </SettingsCard>
  );
}
