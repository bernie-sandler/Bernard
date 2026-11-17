import { Link } from 'react-router';
import { PageHeader } from '../components/Layout.js';
import { ChannelSelect } from '../components/pickers.js';
import { SettingsCard, Toggle, useSettings } from '../components/SettingsForm.js';
import { Card, ErrorBox, Field, FullPageSpinner, Input } from '../components/ui.js';

const LOG_TYPES: { key: string; label: string; hint: string }[] = [
  { key: 'moderation', label: 'Moderation', hint: 'Mod cases from any source' },
  { key: 'members', label: 'Members', hint: 'Joins, leaves, nicknames, tier changes' },
  { key: 'messages', label: 'Messages', hint: 'Edits and deletes' },
  { key: 'voice', label: 'Voice', hint: 'Joins, leaves and moves' },
  { key: 'server', label: 'Server', hint: 'Role and channel changes' },
  { key: 'commands', label: 'Commands', hint: 'Every bot command use' },
];

type Logs = {
  channels: Record<string, string | null>;
  retentionDays: number;
  newAccountDays: number;
  messageCacheSize: number;
};
type Activity = {
  messageCooldownSeconds: number;
  pointsPerMessage: number;
  pointsPerVoiceMinute: number;
  pointsPerImage: number;
  pointsPerLink: number;
  pointsPerReaction: number;
  pointsPerReactionReceived: number;
  reactionReceiveWindowMinutes: number;
  reactionGraceThreshold: number;
  reactionGraceWindowMinutes: number;
  reactionGraceMinutes: number;
  voiceLongSessionMinutes: number;
  voiceLongSessionMultiplier: number;
  countSelfDeafened: boolean;
  windowDays: number;
  resetOnRejoin: boolean;
};

const SUBHEADING = 'text-xs font-semibold tracking-wide text-slate-500 uppercase';

export function SettingsPage() {
  const settings = useSettings();
  if (settings.isPending) return <FullPageSpinner />;
  if (settings.error) return <ErrorBox error={settings.error} onRetry={() => settings.refetch()} />;

  return (
    <>
      <PageHeader
        title="Settings"
        subtitle="Each section needs the same permission as its slash command. Every change is recorded in the audit log."
      />
      <div className="grid gap-4 lg:grid-cols-2">
        <SettingsCard<Logs>
          section="logs"
          title="Logs"
          description="Where each log type is posted. Entries are always stored for the dashboard. The bot posts a test message to a new channel before saving."
        >
          {(s, set, disabled) => (
            <>
              <div className="grid gap-3 sm:grid-cols-2">
                {LOG_TYPES.map((t) => (
                  <Field key={t.key} label={t.label} hint={t.hint}>
                    <ChannelSelect
                      value={s.channels[t.key] ?? ''}
                      kinds={['text', 'announcement']}
                      placeholder="Off"
                      disabled={disabled}
                      onChange={(v) => set('channels', { ...s.channels, [t.key]: v || null })}
                    />
                  </Field>
                ))}
              </div>
              <div className="grid gap-3 sm:grid-cols-3">
                <Field label="Keep stored logs (days)" hint="1–365">
                  <Input
                    type="number"
                    min={1}
                    max={365}
                    disabled={disabled}
                    value={s.retentionDays}
                    onChange={(e) => set('retentionDays', Number(e.target.value))}
                  />
                </Field>
                <Field label="New-account warning (days)" hint="0 = off">
                  <Input
                    type="number"
                    min={0}
                    max={365}
                    disabled={disabled}
                    value={s.newAccountDays}
                    onChange={(e) => set('newAccountDays', Number(e.target.value))}
                  />
                </Field>
                <Field label="Message cache size" hint="For edit/delete logs">
                  <Input
                    type="number"
                    min={100}
                    max={100000}
                    disabled={disabled}
                    value={s.messageCacheSize}
                    onChange={(e) => set('messageCacheSize', Number(e.target.value))}
                  />
                </Field>
              </div>
            </>
          )}
        </SettingsCard>

        <div className="space-y-4">
          <SettingsCard<Activity>
            section="activity"
            title="Activity & tenure"
            description="Scores are recalculated from stored counts, so changing weights re-scores past activity (and can move members across tier thresholds). Image and link points are a bonus on top of the message point. The cooldown applies to messages, images, links and reactions given separately. A member who receives the grace number of reactions within the set time earns no reaction points, given or received, for the grace length."
            extraSections={{ tenure: ['resetOnRejoin'] }}
          >
            {(s, set, disabled) => (
              <>
                <div className="grid gap-3 sm:grid-cols-3">
                  <Field label="Cooldown (s)" hint="Per kind">
                    <Input
                      type="number"
                      min={0}
                      max={3600}
                      disabled={disabled}
                      value={s.messageCooldownSeconds}
                      onChange={(e) => set('messageCooldownSeconds', Number(e.target.value))}
                    />
                  </Field>
                  <Field label="Points per message">
                    <Input
                      type="number"
                      min={0}
                      max={100}
                      step="any"
                      disabled={disabled}
                      value={s.pointsPerMessage}
                      onChange={(e) => set('pointsPerMessage', Number(e.target.value))}
                    />
                  </Field>
                  <Field label="Points per voice minute">
                    <Input
                      type="number"
                      min={0}
                      max={100}
                      step="any"
                      disabled={disabled}
                      value={s.pointsPerVoiceMinute}
                      onChange={(e) => set('pointsPerVoiceMinute', Number(e.target.value))}
                    />
                  </Field>
                  <Field label="Bonus per image">
                    <Input
                      type="number"
                      min={0}
                      max={100}
                      step="any"
                      disabled={disabled}
                      value={s.pointsPerImage}
                      onChange={(e) => set('pointsPerImage', Number(e.target.value))}
                    />
                  </Field>
                  <Field label="Bonus per link">
                    <Input
                      type="number"
                      min={0}
                      max={100}
                      step="any"
                      disabled={disabled}
                      value={s.pointsPerLink}
                      onChange={(e) => set('pointsPerLink', Number(e.target.value))}
                    />
                  </Field>
                  <Field label="Points per reaction">
                    <Input
                      type="number"
                      min={0}
                      max={100}
                      step="any"
                      disabled={disabled}
                      value={s.pointsPerReaction}
                      onChange={(e) => set('pointsPerReaction', Number(e.target.value))}
                    />
                  </Field>
                  <Field label="Rolling window (days)">
                    <Input
                      type="number"
                      min={1}
                      max={365}
                      disabled={disabled}
                      value={s.windowDays}
                      onChange={(e) => set('windowDays', Number(e.target.value))}
                    />
                  </Field>
                </div>
                <h3 className={SUBHEADING}>Long voice sessions</h3>
                <div className="grid gap-3 sm:grid-cols-3">
                  <Field label="Long session after (min)" hint="Applies from now on">
                    <Input
                      type="number"
                      min={1}
                      max={1440}
                      disabled={disabled}
                      value={s.voiceLongSessionMinutes}
                      onChange={(e) => set('voiceLongSessionMinutes', Number(e.target.value))}
                    />
                  </Field>
                  <Field label="Multiplier after that" hint="<1 reduces, >1 rewards">
                    <Input
                      type="number"
                      min={0}
                      max={10}
                      step="any"
                      disabled={disabled}
                      value={s.voiceLongSessionMultiplier}
                      onChange={(e) => set('voiceLongSessionMultiplier', Number(e.target.value))}
                    />
                  </Field>
                </div>
                <h3 className={SUBHEADING}>Reactions received</h3>
                <div className="grid gap-3 sm:grid-cols-3">
                  <Field label="Points per reactor" hint="Each member once per message">
                    <Input
                      type="number"
                      min={0}
                      max={100}
                      step="any"
                      disabled={disabled}
                      value={s.pointsPerReactionReceived}
                      onChange={(e) => set('pointsPerReactionReceived', Number(e.target.value))}
                    />
                  </Field>
                  <Field label="Within (min) of posting">
                    <Input
                      type="number"
                      min={1}
                      max={1440}
                      disabled={disabled}
                      value={s.reactionReceiveWindowMinutes}
                      onChange={(e) => set('reactionReceiveWindowMinutes', Number(e.target.value))}
                    />
                  </Field>
                  <Field label="Grace after (reactions)" hint="0 = never">
                    <Input
                      type="number"
                      min={0}
                      max={1000}
                      disabled={disabled}
                      value={s.reactionGraceThreshold}
                      onChange={(e) => set('reactionGraceThreshold', Number(e.target.value))}
                    />
                  </Field>
                  <Field label="Received within (min)">
                    <Input
                      type="number"
                      min={1}
                      max={1440}
                      disabled={disabled}
                      value={s.reactionGraceWindowMinutes}
                      onChange={(e) => set('reactionGraceWindowMinutes', Number(e.target.value))}
                    />
                  </Field>
                  <Field label="Grace length (min)" hint="No reaction points">
                    <Input
                      type="number"
                      min={1}
                      max={10080}
                      disabled={disabled}
                      value={s.reactionGraceMinutes}
                      onChange={(e) => set('reactionGraceMinutes', Number(e.target.value))}
                    />
                  </Field>
                </div>
                <Toggle
                  label="Count voice time while self-deafened"
                  checked={s.countSelfDeafened}
                  disabled={disabled}
                  onChange={(v) => set('countSelfDeafened', v)}
                />
                <Toggle
                  label="Restart tenure when someone leaves and rejoins"
                  hint="Their first join date is kept either way."
                  checked={s.resetOnRejoin}
                  disabled={disabled}
                  onChange={(v) => set('resetOnRejoin', v)}
                />
              </>
            )}
          </SettingsCard>

          <SettingsCard<{ dmOnAction: boolean }> section="moderation" title="Moderation">
            {(s, set, disabled) => (
              <Toggle
                label="DM members when they're warned, timed out, kicked or banned"
                hint="Best effort: members with DMs closed won't get it."
                checked={s.dmOnAction}
                disabled={disabled}
                onChange={(v) => set('dmOnAction', v)}
              />
            )}
          </SettingsCard>

          <SettingsCard<{ adminBypass: boolean }> section="permissions" title="Permission system">
            {(s, set, disabled) => (
              <Toggle
                label="Members with Discord's Administrator permission bypass permission rules"
                hint="The server owner always bypasses them. Turning this off means Administrators need rules like everyone else."
                checked={s.adminBypass}
                disabled={disabled}
                onChange={(v) => set('adminBypass', v)}
              />
            )}
          </SettingsCard>

          <Card title="Elsewhere">
            <p className="text-sm text-slate-400">
              Tier settings are on the{' '}
              <Link className="text-indigo-300 hover:underline" to="/tiers">
                Tiers
              </Link>{' '}
              page and voice settings on{' '}
              <Link className="text-indigo-300 hover:underline" to="/voice">
                Voice hubs
              </Link>
              .
            </p>
          </Card>
        </div>
      </div>
    </>
  );
}
