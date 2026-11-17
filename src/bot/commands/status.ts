import type { AutocompleteHandler } from '../../services/commands/types.js';
import { defineCommand, defineTree } from '../../services/commands/types.js';
import { UserError } from '../../services/errors.js';
import { KumaError } from '../../services/status/kuma.js';
import { buildStatusEmbed } from '../../services/status/service.js';
import { opt } from '../../shared/commandOptions.js';
import { ok } from '../../shared/commandResult.js';

const actorOf = (ctx: { actor: { userId: string }; source: 'slash' | 'dashboard' }) => ({
  id: ctx.actor.userId,
  source: ctx.source,
});

const monitorAutocomplete: AutocompleteHandler = (ctx, focused) => {
  const q = focused.toLowerCase();
  return (ctx.services.status.view().snapshot?.monitors ?? [])
    .filter((m) => m.name.toLowerCase().includes(q))
    .slice(0, 25)
    .map((m) => ({ name: `${m.group}: ${m.name}`.slice(0, 100), value: String(m.id) }));
};

export const statusCommand = defineTree({
  name: 'status',
  description: 'Server status from Uptime Kuma',
  subcommands: [
    defineCommand({
      name: 'show',
      description: 'Show whether everything is up',
      node: 'public:status',
      options: {},
      async execute(ctx) {
        const { status } = ctx.services;
        if (!status.configured()) throw new UserError('Server status is not set up yet.');
        const view = status.view().fetchedAt ? status.view() : await status.refresh();
        return {
          ok: true,
          embeds: [
            buildStatusEmbed(view.snapshot, {
              error: view.error,
              errorSince: view.errorSince ? Date.parse(view.errorSince) : null,
              now: view.fetchedAt ? Date.parse(view.fetchedAt) : Date.now(),
            }),
          ],
        };
      },
    }),
    defineCommand({
      name: 'setup',
      description: 'Connect an Uptime Kuma status page',
      node: 'config:status',
      options: {
        kuma_url: opt.string({
          description: 'Uptime Kuma address, e.g. http://192.168.1.10:3001',
          required: true,
          maxLength: 500,
        }),
        slug: opt.string({
          description: 'Status page slug (the part after /status/)',
          required: true,
          maxLength: 100,
        }),
        interval: opt.integer({ description: 'Seconds between updates (default 60)', min: 30, max: 3600 }),
      },
      async execute(ctx, input) {
        const url = input.kuma_url.trim().replace(/\/+$/, '');
        const slug = input.slug.trim();
        let count: number;
        try {
          count = (await ctx.services.status.test(url, slug)).monitors.length;
        } catch (err) {
          if (err instanceof KumaError) throw new UserError(err.message);
          throw new UserError("Couldn't read that status page. Check the URL and slug.");
        }
        ctx.services.settings.update(actorOf(ctx), 'settings.status.setup', (s) => {
          s.status.kumaUrl = url;
          s.status.slug = slug;
          if (input.interval !== undefined) s.status.intervalSeconds = input.interval;
        });
        await ctx.services.status.refresh();
        return ok(
          `Connected to Uptime Kuma: ${count} monitor${count === 1 ? '' : 's'} on **${slug}**. ` +
            'Use `/status post` to put the status embed in a channel.',
        );
      },
    }),
    defineCommand({
      name: 'post',
      description: 'Post (or move) the pinned status embed',
      node: 'config:status',
      options: {
        channel: opt.channel({
          description: 'Channel for the status embed',
          required: true,
          channelTypes: ['text', 'announcement'],
        }),
      },
      async execute(ctx, input) {
        await ctx.services.status.setChannel(actorOf(ctx), input.channel);
        return ok(`The status embed is now pinned in <#${input.channel}> and updates itself.`);
      },
    }),
    defineCommand({
      name: 'alerts',
      description: 'Post "down" and "back up" alerts in a channel (leave empty to turn off)',
      node: 'config:status',
      options: {
        channel: opt.channel({ description: 'Alert channel', channelTypes: ['text', 'announcement'] }),
      },
      async execute(ctx, input) {
        ctx.services.settings.update(actorOf(ctx), 'settings.status.alerts', (s) => {
          s.status.alertChannelId = input.channel ?? null;
        });
        return ok(input.channel ? `Status alerts will go to <#${input.channel}>.` : 'Status alerts are off.');
      },
    }),
    defineCommand({
      name: 'notify',
      description: 'Ping a role when a monitor goes down or comes back (leave role empty to stop)',
      node: 'config:status',
      options: {
        monitor: opt.string({ description: 'Monitor', required: true, autocomplete: true, maxLength: 100 }),
        role: opt.role({ description: 'Role to ping, e.g. MC updates' }),
      },
      autocomplete: { monitor: monitorAutocomplete },
      async execute(ctx, input) {
        const monitors = ctx.services.status.view().snapshot?.monitors ?? [];
        const q = input.monitor.trim().toLowerCase();
        const m = monitors.find((x) => String(x.id) === input.monitor || x.name.toLowerCase() === q);
        if (!m) throw new UserError(`No monitor matches "${input.monitor}". Use the suggestions.`);
        ctx.services.status.setAlertRole(actorOf(ctx), m.id, input.role ?? null);
        const where = ctx.services.settings.get().status.alertChannelId;
        const note = where ? '' : ' Alerts are off until you pick a channel with `/status alerts`.';
        return ok(
          (input.role
            ? `<@&${input.role}> will be pinged when **${m.name}** goes down or comes back.`
            : `**${m.name}** alerts won't ping anyone.`) + note,
        );
      },
    }),
    defineCommand({
      name: 'refresh',
      description: 'Read Uptime Kuma and update the status embed now',
      node: 'config:status',
      options: {},
      async execute(ctx) {
        if (!ctx.services.status.configured()) throw new UserError('Run `/status setup` first.');
        const view = await ctx.services.status.refresh();
        if (view.error) throw new UserError(view.error);
        return ok(`Updated: ${view.snapshot?.monitors.length ?? 0} monitors.`);
      },
    }),
  ],
});

export const statusCommands = [statusCommand];
