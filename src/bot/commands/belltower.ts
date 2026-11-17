import { defineCommand, defineTree } from '../../services/commands/types.js';
import { UserError } from '../../services/errors.js';
import { opt } from '../../shared/commandOptions.js';
import { ok } from '../../shared/commandResult.js';

export const reportCommand = defineCommand({
  name: 'report',
  description: "Tell the admins something isn't working (you'll get a message when it's fixed)",
  node: 'public:report',
  options: {
    // Not required: when the panel links to Belltower's submit page, /report only answers with the link.
    service: opt.string({
      description: "What isn't working, e.g. Plex",
      autocomplete: true,
      maxLength: 100,
    }),
    details: opt.string({ description: 'What happens, error messages, since when', maxLength: 1000 }),
  },
  autocomplete: { service: (ctx, focused) => ctx.services.belltower.serviceChoices(focused) },
  async execute(ctx, input) {
    const text = await ctx.services.belltower.report(
      { userId: ctx.actor.userId, username: ctx.actor.username, displayName: ctx.actor.displayName },
      { service: input.service ?? '', details: input.details ?? null, channelId: ctx.channelId ?? null },
    );
    return ok(text);
  },
});

export const belltowerCommand = defineTree({
  name: 'belltower',
  description: 'Issue reports sent to Belltower',
  subcommands: [
    defineCommand({
      name: 'panel',
      description: 'Post (or move) the "Report an issue" button (leave empty to remove it)',
      node: 'config:belltower',
      options: {
        channel: opt.channel({
          description: 'Channel for the panel',
          channelTypes: ['text', 'announcement'],
        }),
      },
      async execute(ctx, input) {
        await ctx.services.belltower.setPanelChannel(
          { id: ctx.actor.userId, source: ctx.source },
          input.channel ?? null,
        );
        return ok(
          input.channel ? `The report panel is now in <#${input.channel}>.` : 'The report panel is removed.',
        );
      },
    }),
    defineCommand({
      name: 'test',
      description: 'Check that Bernard can reach Belltower',
      node: 'config:belltower',
      options: {},
      async execute(ctx) {
        if (!ctx.services.belltower.configured()) {
          throw new UserError('Set BELLTOWER_URL and BELLTOWER_TOKEN, then restart Bernard.');
        }
        await ctx.services.belltower.test();
        return ok('Belltower is reachable and the token works.');
      },
    }),
  ],
});

export const belltowerCommands = [reportCommand, belltowerCommand];
