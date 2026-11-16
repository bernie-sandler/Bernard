import { LOG_TYPES, type LogType } from '../../config/settings.js';
import { defineCommand, defineTree } from '../../services/commands/types.js';
import { UserError } from '../../services/errors.js';
import { opt } from '../../shared/commandOptions.js';
import { COLORS, ok } from '../../shared/commandResult.js';

const LOG_DESCRIPTIONS: Record<LogType, string> = {
  moderation: 'Mod cases from any source',
  members: 'Joins, leaves, nicknames, tier changes',
  messages: 'Message edits and deletes',
  voice: 'Voice joins, leaves and moves',
  server: 'Role/channel changes, member role changes',
  commands: 'Every bot command use',
};

const typeOpt = opt.string({
  description: 'Log type',
  required: true,
  choices: LOG_TYPES.map((t) => ({ name: `${t}: ${LOG_DESCRIPTIONS[t]}`.slice(0, 100), value: t })),
});

export const logsCommand = defineTree({
  name: 'logs',
  description: 'Configure log channels',
  subcommands: [
    defineCommand({
      name: 'set',
      description: 'Send a log type to a channel',
      node: 'config:logs',
      options: {
        type: typeOpt,
        channel: opt.channel({
          description: 'Log channel',
          required: true,
          channelTypes: ['text', 'announcement'],
        }),
      },
      async execute(ctx, input) {
        const type = input.type as LogType;
        const { settings, messenger } = ctx.services;
        // Prove the bot can post there before saving.
        const posted = await messenger
          .sendEmbed(input.channel, {
            title: 'Log channel connected',
            description: `This channel now receives **${type}** logs (${LOG_DESCRIPTIONS[type]}).`,
            color: COLORS.success,
            footer: `Set by ${ctx.actor.displayName}`,
          })
          .catch(() => null);
        if (!posted) {
          throw new UserError(
            `I can't post in <#${input.channel}>. Give me View Channel, Send Messages and Embed Links there.`,
          );
        }
        settings.update({ id: ctx.actor.userId, source: ctx.source }, 'settings.logs.set', (s) => {
          s.logs.channels[type] = input.channel;
        });
        return ok(`**${type}** logs will go to <#${input.channel}>.`);
      },
    }),
    defineCommand({
      name: 'disable',
      description: 'Stop posting a log type (entries are still stored for the dashboard)',
      node: 'config:logs',
      options: { type: typeOpt },
      async execute(ctx, input) {
        const type = input.type as LogType;
        ctx.services.settings.update(
          { id: ctx.actor.userId, source: ctx.source },
          'settings.logs.disable',
          (s) => {
            s.logs.channels[type] = null;
          },
        );
        return ok(`**${type}** logs are no longer posted to a channel.`);
      },
    }),
    defineCommand({
      name: 'list',
      description: 'Show where each log type goes',
      node: 'config:logs',
      options: {},
      async execute(ctx) {
        const s = ctx.services.settings.get().logs;
        const lines = LOG_TYPES.map(
          (t) => `**${t}**: ${s.channels[t] ? `<#${s.channels[t]}>` : '*off*'}  · ${LOG_DESCRIPTIONS[t]}`,
        );
        return ok('', {
          embeds: [
            {
              title: 'Log routing',
              color: COLORS.info,
              description: lines.join('\n'),
              fields: [
                { name: 'Retention', value: `${s.retentionDays} days`, inline: true },
                { name: 'New-account warning', value: `< ${s.newAccountDays} days`, inline: true },
                { name: 'Message cache', value: `${s.messageCacheSize} messages`, inline: true },
              ],
            },
          ],
        });
      },
    }),
    defineCommand({
      name: 'config',
      description: 'Change log retention, new-account warning and message cache size',
      node: 'config:logs',
      options: {
        retention_days: opt.integer({
          description: 'Keep stored logs this many days (1-365)',
          min: 1,
          max: 365,
        }),
        new_account_days: opt.integer({
          description: 'Warn on joins from accounts younger than this (0 = off)',
          min: 0,
          max: 365,
        }),
        cache_size: opt.integer({
          description: 'Messages kept in memory for edit/delete logs (100-100000)',
          min: 100,
          max: 100_000,
        }),
      },
      async execute(ctx, input) {
        if (
          input.retention_days === undefined &&
          input.new_account_days === undefined &&
          input.cache_size === undefined
        ) {
          throw new UserError('Pass at least one option. Use /logs list to see current values.');
        }
        const next = ctx.services.settings.update(
          { id: ctx.actor.userId, source: ctx.source },
          'settings.logs.config',
          (s) => {
            if (input.retention_days !== undefined) s.logs.retentionDays = input.retention_days;
            if (input.new_account_days !== undefined) s.logs.newAccountDays = input.new_account_days;
            if (input.cache_size !== undefined) s.logs.messageCacheSize = input.cache_size;
          },
        ).logs;
        return ok(
          `Saved. Retention: ${next.retentionDays}d • New-account warning: < ${next.newAccountDays}d • Cache: ${next.messageCacheSize} messages.`,
        );
      },
    }),
  ],
});
