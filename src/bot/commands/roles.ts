import type { AutocompleteHandler } from '../../services/commands/types.js';
import { defineCommand, defineTree } from '../../services/commands/types.js';
import { UserError } from '../../services/errors.js';
import type { RolePanel } from '../../services/rolePanels.js';
import { opt } from '../../shared/commandOptions.js';
import { COLORS, ok } from '../../shared/commandResult.js';

const actorOf = (ctx: { actor: { userId: string }; source: 'slash' | 'dashboard' }) => ({
  id: ctx.actor.userId,
  source: ctx.source,
});

const panelAutocomplete: AutocompleteHandler = (ctx, focused) => {
  const q = focused.toLowerCase();
  return ctx.services.rolePanels
    .list()
    .filter((p) => p.title.toLowerCase().includes(q))
    .slice(0, 25)
    .map((p) => ({ name: `#${p.id} ${p.title}`.slice(0, 100), value: String(p.id) }));
};

const panelOpt = opt.string({
  description: 'Role panel',
  required: true,
  autocomplete: true,
  maxLength: 100,
});

function resolvePanel(ctx: Parameters<AutocompleteHandler>[0], ref: string): RolePanel {
  const p = ctx.services.rolePanels.find(ref);
  if (!p) throw new UserError(`No role panel matches "${ref}". Create panels on the dashboard.`);
  return p;
}

const where = (p: RolePanel) => (p.channelId ? `posted in <#${p.channelId}>` : 'not posted');

export const rolePanelCommand = defineTree({
  name: 'rolepanel',
  description: 'Self-assign role panels (create and edit them on the dashboard)',
  subcommands: [
    defineCommand({
      name: 'list',
      description: 'List role panels',
      node: 'config:rolepanels',
      options: {},
      async execute(ctx) {
        const panels = ctx.services.rolePanels.list();
        if (panels.length === 0) return ok('No role panels yet. Create one on the dashboard.');
        return {
          ok: true,
          embeds: [
            {
              title: 'Role panels',
              color: COLORS.info,
              description: panels
                .map(
                  (p) =>
                    `**#${p.id} ${p.title}** · ${p.style}, ${p.mode} · ${p.options.length} roles · ${where(p)}`,
                )
                .join('\n')
                .slice(0, 4096),
            },
          ],
        };
      },
    }),
    defineCommand({
      name: 'post',
      description: 'Post a role panel in a channel (moves it if it was posted elsewhere)',
      node: 'config:rolepanels',
      options: {
        panel: panelOpt,
        channel: opt.channel({
          description: 'Channel to post in',
          required: true,
          channelTypes: ['text', 'announcement'],
        }),
      },
      autocomplete: { panel: panelAutocomplete },
      async execute(ctx, input) {
        const p = resolvePanel(ctx, input.panel);
        await ctx.services.rolePanels.post(actorOf(ctx), p.id, input.channel);
        return ok(`Posted **${p.title}** in <#${input.channel}>.`);
      },
    }),
    defineCommand({
      name: 'refresh',
      description: "Update a posted panel's message (e.g. after renaming a role)",
      node: 'config:rolepanels',
      options: { panel: panelOpt },
      autocomplete: { panel: panelAutocomplete },
      async execute(ctx, input) {
        const p = resolvePanel(ctx, input.panel);
        if (!p.channelId) throw new UserError(`**${p.title}** isn't posted yet. Use \`/rolepanel post\`.`);
        await ctx.services.rolePanels.refresh(p.id);
        return ok(`Updated **${p.title}**.`);
      },
    }),
    defineCommand({
      name: 'delete',
      description: 'Delete a role panel and its message (members keep their roles)',
      node: 'config:rolepanels',
      options: { panel: panelOpt },
      autocomplete: { panel: panelAutocomplete },
      async execute(ctx, input) {
        const p = resolvePanel(ctx, input.panel);
        await ctx.services.rolePanels.remove(actorOf(ctx), p.id);
        return ok(`Deleted **${p.title}**.`);
      },
    }),
  ],
});

export const roleCommands = [rolePanelCommand];
