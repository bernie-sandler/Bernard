import type { AutocompleteHandler } from '../../services/commands/types.js';
import { defineCommand, defineTree } from '../../services/commands/types.js';
import { UserError } from '../../services/errors.js';
import { MAX_TIERS, type TierRow } from '../../services/tiers.js';
import { opt } from '../../shared/commandOptions.js';
import { COLORS, ok } from '../../shared/commandResult.js';

const tierAutocomplete: AutocompleteHandler = (ctx, focused) => {
  const q = focused.toLowerCase();
  return ctx.services.tiers
    .list()
    .filter((t) => t.name.toLowerCase().includes(q))
    .slice(0, 25)
    .map((t) => ({ name: `${t.position}. ${t.name}`.slice(0, 100), value: String(t.id) }));
};

const tierOpt = opt.string({ description: 'Tier', required: true, autocomplete: true, maxLength: 50 });

function resolveTier(ctx: Parameters<AutocompleteHandler>[0], ref: string): TierRow {
  const t = ctx.services.tiers.find(ref);
  if (!t) throw new UserError(`No tier matches "${ref}". Use autocomplete or /tiers list.`);
  return t;
}

const fmtPoints = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

function tierLine(t: TierRow, members?: number): string {
  const req = [
    t.minTenureDays ? `≥ ${t.minTenureDays}d tenure` : null,
    t.minActivity ? `≥ ${fmtPoints(t.minActivity)} activity` : null,
  ].filter(Boolean);
  return `**${t.position}. ${t.name}** <@&${t.roleId}> · ${req.join(' + ') || 'everyone'}${members !== undefined ? ` · ${members} member(s)` : ''}`;
}

const actorOf = (ctx: { actor: { userId: string }; source: 'slash' | 'dashboard' }) => ({
  id: ctx.actor.userId,
  source: ctx.source,
});

export const tiersCommand = defineTree({
  name: 'tiers',
  description: 'Tenure and activity tiers',
  subcommands: [
    defineCommand({
      name: 'list',
      description: 'Show tiers, member counts and settings',
      node: 'config:tiers',
      options: {},
      async execute(ctx) {
        const { tiers, settings } = ctx.services;
        const check = tiers.check();
        const s = settings.get();
        const last = tiers.lastSync();
        return ok('', {
          embeds: [
            {
              title: `Tiers (${check.tiers.length}/${MAX_TIERS})`,
              color: check.ok ? COLORS.info : COLORS.warning,
              description:
                check.tiers.map((r) => tierLine(r.tier, r.members)).join('\n') ||
                'No tiers yet. Add one with `/tiers add`.',
              fields: [
                {
                  name: 'Settings',
                  value: [
                    `Mode: ${s.tiers.mode === 'highest_only' ? 'highest tier only' : 'stack all earned tiers'}`,
                    `Demotion: ${s.tiers.demotion ? `on, after ${s.tiers.demotionGraceDays} day(s) below` : 'off'}`,
                    `Activity window: ${s.activity.windowDays} days · Sync every ${s.tiers.syncIntervalMinutes} min`,
                    `Excluded roles: ${s.tiers.excludedRoleIds.map((r) => `<@&${r}>`).join(' ') || 'none'}`,
                  ].join('\n'),
                },
                {
                  name: 'Last sync',
                  value: last
                    ? `<t:${Math.floor(Date.parse(last.at) / 1000)}:R> · ${last.changed} changed of ${last.members}${last.errors ? ` · ${last.errors} error(s)` : ''}`
                    : 'Never',
                },
                ...(check.ok ? [] : [{ name: '⚠️ Problems', value: check.issues.join('\n').slice(0, 1024) }]),
              ],
            },
          ],
        });
      },
    }),
    defineCommand({
      name: 'add',
      description: 'Add a tier (max 10)',
      node: 'config:tiers',
      options: {
        name: opt.string({ description: 'Tier name', required: true, maxLength: 50 }),
        role: opt.role({ description: 'Role members get', required: true }),
        min_tenure_days: opt.integer({
          description: 'Days in the server (0 = activity only)',
          required: true,
          min: 0,
          max: 36500,
        }),
        min_activity: opt.number({
          description: 'Activity score over the window (0 = tenure only)',
          required: true,
          min: 0,
        }),
        position: opt.integer({
          description: 'Position (1 = lowest); defaults to the top',
          min: 1,
          max: MAX_TIERS,
        }),
      },
      async execute(ctx, input) {
        const t = ctx.services.tiers.add(actorOf(ctx), {
          name: input.name,
          roleId: input.role,
          minTenureDays: input.min_tenure_days,
          minActivity: input.min_activity,
          ...(input.position !== undefined ? { position: input.position } : {}),
        });
        const warn = ctx.services.tiers.check().tiers.find((r) => r.tier.id === t.id)?.problem;
        return ok(
          `Added ${tierLine(t)}.${warn ? `\n⚠️ ${warn}: the bot can't assign it yet.` : ''}\nRun \`/tiers sync\` to apply now.`,
        );
      },
    }),
    defineCommand({
      name: 'edit',
      description: 'Change a tier',
      node: 'config:tiers',
      options: {
        tier: tierOpt,
        name: opt.string({ description: 'New name', maxLength: 50 }),
        role: opt.role({ description: 'New role' }),
        min_tenure_days: opt.integer({ description: 'Days in the server', min: 0, max: 36500 }),
        min_activity: opt.number({ description: 'Activity score over the window', min: 0 }),
        position: opt.integer({ description: 'Position (1 = lowest)', min: 1, max: MAX_TIERS }),
      },
      autocomplete: { tier: tierAutocomplete },
      async execute(ctx, input) {
        const t = resolveTier(ctx, input.tier);
        const updated = ctx.services.tiers.edit(actorOf(ctx), t.id, {
          ...(input.name ? { name: input.name } : {}),
          ...(input.role ? { roleId: input.role } : {}),
          ...(input.min_tenure_days !== undefined ? { minTenureDays: input.min_tenure_days } : {}),
          ...(input.min_activity !== undefined ? { minActivity: input.min_activity } : {}),
          ...(input.position !== undefined ? { position: input.position } : {}),
        });
        return ok(`Updated ${tierLine(updated)}.`);
      },
    }),
    defineCommand({
      name: 'remove',
      description: 'Delete a tier (its role is left on members)',
      node: 'config:tiers',
      options: { tier: tierOpt },
      autocomplete: { tier: tierAutocomplete },
      async execute(ctx, input) {
        const t = ctx.services.tiers.remove(actorOf(ctx), resolveTier(ctx, input.tier).id);
        return ok(`Removed tier **${t.name}**. Members keep <@&${t.roleId}> until you remove it.`);
      },
    }),
    defineCommand({
      name: 'check',
      description: 'Validate tiers and the role hierarchy',
      node: 'config:tiers',
      options: {},
      async execute(ctx) {
        const c = ctx.services.tiers.check();
        if (c.tiers.length === 0) return ok('No tiers configured.');
        return ok('', {
          embeds: [
            {
              title: c.ok ? '✅ Tier configuration looks good' : '⚠️ Tier configuration has problems',
              color: c.ok ? COLORS.success : COLORS.warning,
              description: c.tiers
                .map(
                  (r) =>
                    `${r.manageable ? '✅' : '⛔'} ${tierLine(r.tier, r.members)}${r.problem ? ` (${r.problem})` : ''}`,
                )
                .join('\n'),
              ...(c.ok ? {} : { fields: [{ name: 'Fix', value: c.issues.join('\n').slice(0, 1024) }] }),
            },
          ],
        });
      },
    }),
    defineCommand({
      name: 'sync',
      description: 'Re-evaluate every member now',
      node: 'config:tiers',
      options: {},
      async execute(ctx) {
        if (ctx.services.tiers.list().length === 0) throw new UserError('No tiers configured.');
        const s = await ctx.services.tiers.syncAll(`manual sync by ${ctx.actor.displayName}`);
        return ok(
          `Synced ${s.members} member(s): ${s.changed} changed${s.skipped ? `, ${s.skipped} role change(s) skipped (hierarchy; see /tiers check)` : ''}${s.errors ? `, ${s.errors} error(s)` : ''}.`,
        );
      },
    }),
    defineCommand({
      name: 'tenure-sync',
      description: 'Put every member in the tier their tenure earns (ignores activity)',
      node: 'config:tiers',
      options: {
        preview: opt.boolean({ description: 'Show what would change without changing any roles' }),
      },
      async execute(ctx, input) {
        const { tiers, settings } = ctx.services;
        if (tiers.list().length === 0) throw new UserError('No tiers configured.');
        const preview = input.preview === true;
        const s = await tiers.syncAll(`tenure-only sync by ${ctx.actor.displayName}`, {
          tenureOnly: true,
          ...(preview ? { dryRun: true } : {}),
        });
        const t = settings.get().tiers;
        const moves = (s.byTier ?? [])
          .filter((b) => b.gained || b.lost)
          .map(
            (b) =>
              `• **${b.name}**: ${[b.gained ? `+${b.gained}` : null, b.lost ? `−${b.lost}` : null].filter(Boolean).join(' / ')}`,
          );
        const verb = preview ? 'would change' : 'changed';
        const lines = [
          `${preview ? '🔍 Preview: tenure' : 'Tenure'}-only sync of ${s.members} member(s): ${s.changed} ${verb}${s.skipped ? `, ${s.skipped} role change(s) skipped (hierarchy; see /tiers check)` : ''}${s.errors ? `, ${s.errors} error(s)` : ''}.`,
          ...(moves.length ? [moves.join('\n')] : []),
          preview
            ? 'Nothing was changed. Run `/tiers tenure-sync` without `preview` to apply.'
            : 'Activity requirements were ignored; each member now has the tier their tenure earns.',
        ];
        if (t.demotion) {
          lines.push(
            `⚠️ Demotion is on: the regular hourly sync still checks activity, so members who don't meet a tier's activity requirement will lose it after the ${t.demotionGraceDays}-day grace period. To keep roles while activity history builds up, run \`/tiers settings demotion:false\`.`,
          );
        }
        return ok(lines.join('\n'));
      },
    }),
    defineCommand({
      name: 'settings',
      description: 'Tier mode, demotion and sync interval',
      node: 'config:tiers',
      options: {
        mode: opt.string({
          description: 'Keep only the highest tier, or every earned tier',
          choices: [
            { name: 'highest only', value: 'highest_only' },
            { name: 'stack', value: 'stack' },
          ],
        }),
        demotion: opt.boolean({ description: 'Remove tiers when activity drops below the threshold' }),
        grace_days: opt.integer({ description: 'Days below a threshold before demotion', min: 0, max: 90 }),
        sync_minutes: opt.integer({ description: 'Minutes between automatic syncs', min: 5, max: 1440 }),
      },
      async execute(ctx, input) {
        if (
          !input.mode &&
          input.demotion === undefined &&
          input.grace_days === undefined &&
          input.sync_minutes === undefined
        ) {
          throw new UserError('Pass at least one option. Use /tiers list to see current values.');
        }
        const t = ctx.services.settings.update(actorOf(ctx), 'settings.tiers', (s) => {
          if (input.mode) s.tiers.mode = input.mode as 'highest_only' | 'stack';
          if (input.demotion !== undefined) s.tiers.demotion = input.demotion;
          if (input.grace_days !== undefined) s.tiers.demotionGraceDays = input.grace_days;
          if (input.sync_minutes !== undefined) s.tiers.syncIntervalMinutes = input.sync_minutes;
        }).tiers;
        return ok(
          `Saved. Mode: ${t.mode} · Demotion: ${t.demotion ? `on (${t.demotionGraceDays}d grace)` : 'off'} · Sync every ${t.syncIntervalMinutes} min.`,
        );
      },
    }),
    defineCommand({
      name: 'exclude',
      description: 'Toggle a role whose members are skipped by tiers (e.g. staff)',
      node: 'config:tiers',
      options: { role: opt.role({ description: 'Role to exclude or include again', required: true }) },
      async execute(ctx, input) {
        let excluded = false;
        ctx.services.settings.update(actorOf(ctx), 'settings.tiers.exclude', (s) => {
          const list = s.tiers.excludedRoleIds;
          excluded = !list.includes(input.role);
          s.tiers.excludedRoleIds = excluded ? [...list, input.role] : list.filter((r) => r !== input.role);
        });
        return ok(
          excluded
            ? `Members with <@&${input.role}> are now skipped by tier sync.`
            : `Members with <@&${input.role}> are evaluated for tiers again.`,
        );
      },
    }),
  ],
});

export const activityCommand = defineTree({
  name: 'activity',
  description: 'Activity scoring settings',
  subcommands: [
    defineCommand({
      name: 'settings',
      description: 'Scoring weights, cooldown, window and tenure rules',
      node: 'config:activity',
      options: {
        message_cooldown: opt.integer({
          description: 'Seconds between messages that earn a point',
          min: 0,
          max: 3600,
        }),
        points_per_message: opt.number({ description: 'Points per counted message', min: 0, max: 100 }),
        points_per_voice_minute: opt.number({ description: 'Points per voice minute', min: 0, max: 100 }),
        count_deafened: opt.boolean({ description: 'Count voice time while self-deafened' }),
        window_days: opt.integer({
          description: 'Rolling window for activity scores (days)',
          min: 1,
          max: 365,
        }),
        reset_tenure_on_rejoin: opt.boolean({
          description: 'Restart tenure when someone leaves and rejoins',
        }),
      },
      async execute(ctx, input) {
        if (Object.values(input).every((v) => v === undefined)) {
          const a = ctx.services.settings.get().activity;
          const t = ctx.services.settings.get().tenure;
          return ok(
            `Cooldown ${a.messageCooldownSeconds}s · ${a.pointsPerMessage} pt/message · ${a.pointsPerVoiceMinute} pt/voice minute · deafened ${a.countSelfDeafened ? 'counts' : "doesn't count"} · window ${a.windowDays}d · tenure ${t.resetOnRejoin ? 'resets' : 'kept'} on rejoin.`,
          );
        }
        const s = ctx.services.settings.update(actorOf(ctx), 'settings.activity', (d) => {
          if (input.message_cooldown !== undefined)
            d.activity.messageCooldownSeconds = input.message_cooldown;
          if (input.points_per_message !== undefined) d.activity.pointsPerMessage = input.points_per_message;
          if (input.points_per_voice_minute !== undefined)
            d.activity.pointsPerVoiceMinute = input.points_per_voice_minute;
          if (input.count_deafened !== undefined) d.activity.countSelfDeafened = input.count_deafened;
          if (input.window_days !== undefined) d.activity.windowDays = input.window_days;
          if (input.reset_tenure_on_rejoin !== undefined)
            d.tenure.resetOnRejoin = input.reset_tenure_on_rejoin;
        });
        return ok(
          `Saved. Cooldown ${s.activity.messageCooldownSeconds}s · ${s.activity.pointsPerMessage} pt/message · ${s.activity.pointsPerVoiceMinute} pt/voice minute · window ${s.activity.windowDays}d.`,
        );
      },
    }),
  ],
});

export const rank = defineCommand({
  name: 'rank',
  description: 'Show tenure, activity and tier progress',
  node: 'public:rank',
  ephemeral: false,
  options: { user: opt.user({ description: 'Member to look up (defaults to you)' }) },
  async execute(ctx, input) {
    const { guild, tiers, activity, settings } = ctx.services;
    const userId = input.user ?? ctx.actor.userId;
    const member = await guild.getMember(userId);
    if (!member) throw new UserError('That user is not a member of this server.');
    const p = tiers.progress(member);
    const window = settings.get().activity.windowDays;
    const board = activity.allTotals();
    const position = board.findIndex((b) => b.userId === userId);
    const ts = (d: Date) => `<t:${Math.floor(d.getTime() / 1000)}:D>`;
    const rejoined = p.firstJoinedAt.getTime() < p.joinedAt.getTime() - 60_000;
    const next = p.next
      ? p.next.daysNeeded === 0 && p.next.pointsNeeded === 0
        ? `**${p.next.tier.name}**: requirements met, it will be applied at the next sync`
        : `**${p.next.tier.name}**: ${[
            p.next.daysNeeded ? `${p.next.daysNeeded} more day(s)` : null,
            p.next.pointsNeeded ? `${fmtPoints(p.next.pointsNeeded)} more activity` : null,
          ]
            .filter(Boolean)
            .join(' and ')}`
      : tiers.list().length
        ? 'Top tier reached 🎉'
        : 'No tiers configured';
    return ok('', {
      embeds: [
        {
          title: member.displayName,
          color: COLORS.info,
          ...(member.avatarUrl ? { thumbnailUrl: member.avatarUrl } : {}),
          fields: [
            {
              name: 'Tenure',
              value: `${p.tenureDays} day(s) (since ${ts(p.joinedAt)})${rejoined ? `\nFirst joined ${ts(p.firstJoinedAt)}` : ''}`,
              inline: true,
            },
            {
              name: `Activity (${window}d)`,
              value: `**${fmtPoints(p.totals.score)}** points\n${p.totals.messagePoints} message(s) · ${p.totals.voiceMinutes} voice min`,
              inline: true,
            },
            {
              name: 'Rank',
              value: position >= 0 ? `#${position + 1} of ${board.length}` : 'Unranked',
              inline: true,
            },
            {
              name: 'Tier',
              value: p.current ? `**${p.current.name}** <@&${p.current.roleId}>` : 'None yet',
              inline: true,
            },
            { name: 'Next', value: next },
          ],
        },
      ],
    });
  },
});

export const tierCommands = [tiersCommand, activityCommand, rank];
