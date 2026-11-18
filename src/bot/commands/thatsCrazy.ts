import { defineCommand, defineTree } from '../../services/commands/types.js';
import { opt } from '../../shared/commandOptions.js';
import { COLORS, ok } from '../../shared/commandResult.js';

const ts = (d: Date) => `<t:${Math.floor(d.getTime() / 1000)}:R>`;

export const thatsCrazyCommand = defineCommand({
  name: 'thatscrazy',
  description: 'Someone said something crazy? Start a vote (or join the one already running)',
  node: 'public:thatscrazy',
  // The poll is posted in the channel, so it only makes sense from Discord.
  dashboard: false,
  options: {
    user: opt.user({ description: 'Who said it', required: true }),
  },
  async execute(ctx, input) {
    return ok(await ctx.services.thatsCrazy.invoke(ctx.actor.userId, input.user, ctx.channelId));
  },
});

export const crazyAdminCommand = defineTree({
  name: 'crazy',
  description: "That's crazy strikes",
  subcommands: [
    defineCommand({
      name: 'strikes',
      description: "Show a member's that's crazy strikes and running penalties",
      node: 'admin:crazy',
      options: { user: opt.user({ description: 'Member', required: true }) },
      async execute(ctx, input) {
        const s = ctx.services.thatsCrazy.strikes(input.user);
        const history = s.history.length
          ? s.history
              .map(
                (h) => `${ts(h.at)}${h.strike ? ` · strike ${h.strike}` : ''}${h.pardoned ? ' · reset' : ''}`,
              )
              .join('\n')
          : 'None';
        const active = s.active.length
          ? s.active
              .map(
                (a) =>
                  `${a.action} until ${ts(a.endsAt)}${a.waiting ? ' (waiting for them to join voice)' : ''}`,
              )
              .join('\n')
          : 'None';
        return ok('', {
          embeds: [
            {
              title: "That's crazy strikes",
              description: `<@${input.user}> has **${s.strikes}** strike${s.strikes === 1 ? '' : 's'} right now.`,
              color: COLORS.info,
              fields: [
                { name: 'Running penalties', value: active },
                { name: 'Recent passed votes', value: history },
              ],
            },
          ],
        });
      },
    }),
    defineCommand({
      name: 'reset',
      description: "Clear a member's that's crazy strikes and end their penalties",
      node: 'admin:crazy',
      options: { user: opt.user({ description: 'Member', required: true }) },
      async execute(ctx, input) {
        const cleared = await ctx.services.thatsCrazy.reset(
          { id: ctx.actor.userId, source: ctx.source },
          input.user,
        );
        return ok(
          `Cleared ${cleared} strike${cleared === 1 ? '' : 's'} for <@${input.user}> and ended their penalties.`,
        );
      },
    }),
  ],
});

export const thatsCrazyCommands = [thatsCrazyCommand, crazyAdminCommand];
