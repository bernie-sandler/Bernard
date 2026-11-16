import { defineCommand, defineTree } from '../../services/commands/types.js';
import { UserError } from '../../services/errors.js';
import { DEFAULT_NAME_TEMPLATE, type Hub } from '../../services/voice.js';
import { opt } from '../../shared/commandOptions.js';
import { COLORS, ok } from '../../shared/commandResult.js';

const typeOpt = <R extends boolean>(required: R) =>
  opt.string({
    description: 'public: anyone can join • private: only invited members can connect',
    required,
    choices: [
      { name: 'public', value: 'public' },
      { name: 'private', value: 'private' },
    ],
  });

const templateOpt = opt.string({
  description: `Channel name template: {user}, {username}, {count} (default "${DEFAULT_NAME_TEMPLATE}")`,
  maxLength: 100,
});
const limitOpt = opt.integer({ description: 'Default user limit (0 = unlimited)', min: 0, max: 99 });
const hideOpt = opt.boolean({ description: 'Private hubs: also hide the channel from @everyone' });

function describeHub(h: Hub): string {
  const extras = [
    `category <#${h.categoryId}>`,
    `name "${h.nameTemplate}"`,
    h.defaultLimit ? `limit ${h.defaultLimit}` : 'no limit',
    ...(h.type === 'private' && h.hideFromEveryone ? ['hidden'] : []),
  ];
  return `<#${h.channelId}> **${h.type}** · ${extras.join(' · ')}`;
}

export const voiceCommand = defineTree({
  name: 'voice',
  description: 'Configure join-to-create voice hubs',
  groups: [
    {
      name: 'hub',
      description: 'Manage join-to-create hubs',
      subcommands: [
        defineCommand({
          name: 'add',
          description: 'Turn a voice channel into a join-to-create hub',
          node: 'config:voice',
          options: {
            channel: opt.channel({
              description: 'Voice channel members join',
              required: true,
              channelTypes: ['voice'],
            }),
            type: typeOpt(true),
            category: opt.channel({
              description: 'Category to create channels in',
              required: true,
              channelTypes: ['category'],
            }),
            name_template: templateOpt,
            default_limit: limitOpt,
            hide: hideOpt,
          },
          async execute(ctx, input) {
            const hub = ctx.services.voice.addHub(
              { id: ctx.actor.userId, source: ctx.source },
              {
                channelId: input.channel,
                type: input.type as 'public' | 'private',
                categoryId: input.category,
                ...(input.name_template ? { nameTemplate: input.name_template } : {}),
                ...(input.default_limit !== undefined ? { defaultLimit: input.default_limit } : {}),
                ...(input.hide !== undefined ? { hideFromEveryone: input.hide } : {}),
              },
            );
            return ok(`Hub created: ${describeHub(hub)}`);
          },
        }),
        defineCommand({
          name: 'edit',
          description: "Change a hub's settings",
          node: 'config:voice',
          options: {
            channel: opt.channel({ description: 'The hub', required: true, channelTypes: ['voice'] }),
            type: typeOpt(false),
            category: opt.channel({
              description: 'Category to create channels in',
              channelTypes: ['category'],
            }),
            name_template: templateOpt,
            default_limit: limitOpt,
            hide: hideOpt,
          },
          async execute(ctx, input) {
            const hub = ctx.services.voice.editHub(
              { id: ctx.actor.userId, source: ctx.source },
              input.channel,
              {
                ...(input.type ? { type: input.type as 'public' | 'private' } : {}),
                ...(input.category ? { categoryId: input.category } : {}),
                ...(input.name_template ? { nameTemplate: input.name_template } : {}),
                ...(input.default_limit !== undefined ? { defaultLimit: input.default_limit } : {}),
                ...(input.hide !== undefined ? { hideFromEveryone: input.hide } : {}),
              },
            );
            return ok(`Hub updated: ${describeHub(hub)}`);
          },
        }),
        defineCommand({
          name: 'remove',
          description: 'Stop a channel being a hub (existing temp channels stay until empty)',
          node: 'config:voice',
          options: {
            channel: opt.channel({ description: 'The hub', required: true, channelTypes: ['voice'] }),
          },
          async execute(ctx, input) {
            ctx.services.voice.removeHub({ id: ctx.actor.userId, source: ctx.source }, input.channel);
            return ok(`<#${input.channel}> is no longer a hub.`);
          },
        }),
        defineCommand({
          name: 'list',
          description: 'List hubs and active temporary channels',
          node: 'config:voice',
          options: {},
          async execute(ctx) {
            const { voice, settings } = ctx.services;
            const hubs = voice.listHubs();
            const active = voice.activeChannels();
            const s = settings.get().voice;
            return ok('', {
              embeds: [
                {
                  title: 'Voice hubs',
                  color: COLORS.info,
                  description: hubs.length
                    ? hubs.map(describeHub).join('\n')
                    : 'No hubs yet. Add one with `/voice hub add`.',
                  fields: [
                    {
                      name: `Active channels (${active.length})`,
                      value:
                        active
                          .slice(0, 15)
                          .map(
                            (a) =>
                              `<#${a.channelId}> · ${a.members.length} in · owner ${a.ownerId ? `<@${a.ownerId}>` : '*none*'}`,
                          )
                          .join('\n') || 'None',
                    },
                    {
                      name: 'Settings',
                      value: `Delete after ${s.graceSeconds}s empty · Hub cooldown ${s.hubCooldownSeconds}s · Owner leaves: ${s.ownerLeaveMode}`,
                    },
                  ],
                },
              ],
            });
          },
        }),
      ],
    },
  ],
  subcommands: [
    defineCommand({
      name: 'settings',
      description: 'Grace period, hub cooldown and what happens when the owner leaves',
      node: 'config:voice',
      options: {
        grace_seconds: opt.integer({
          description: 'Seconds an empty channel waits before deletion',
          min: 0,
          max: 300,
        }),
        cooldown_seconds: opt.integer({
          description: 'Seconds between channel creations per user',
          min: 0,
          max: 3600,
        }),
        owner_leave: opt.string({
          description: 'When the owner leaves a non-empty channel',
          choices: [
            { name: 'transfer to the longest-present member', value: 'transfer' },
            { name: 'let someone /vc claim it', value: 'claim' },
          ],
        }),
      },
      async execute(ctx, input) {
        if (input.grace_seconds === undefined && input.cooldown_seconds === undefined && !input.owner_leave) {
          throw new UserError('Pass at least one option. Use /voice hub list to see current values.');
        }
        const s = ctx.services.settings.update(
          { id: ctx.actor.userId, source: ctx.source },
          'settings.voice',
          (draft) => {
            if (input.grace_seconds !== undefined) draft.voice.graceSeconds = input.grace_seconds;
            if (input.cooldown_seconds !== undefined) draft.voice.hubCooldownSeconds = input.cooldown_seconds;
            if (input.owner_leave) draft.voice.ownerLeaveMode = input.owner_leave as 'transfer' | 'claim';
          },
        ).voice;
        return ok(
          `Saved. Delete after ${s.graceSeconds}s empty · Hub cooldown ${s.hubCooldownSeconds}s · Owner leaves: ${s.ownerLeaveMode}.`,
        );
      },
    }),
  ],
});

const memberOpt = (description: string) => opt.user({ description, required: true as const });

export const vcCommand = defineTree({
  name: 'vc',
  description: 'Manage your temporary voice channel',
  subcommands: [
    defineCommand({
      name: 'lock',
      description: 'Stop new people joining (people inside can still reconnect)',
      node: 'voice:lock',
      options: {},
      async execute(ctx) {
        const id = await ctx.services.voice.lock(ctx.actor.userId);
        return ok(`🔒 <#${id}> is locked. Use \`/vc invite\` to let someone in.`);
      },
    }),
    defineCommand({
      name: 'unlock',
      description: 'Let anyone join your channel again',
      node: 'voice:unlock',
      options: {},
      async execute(ctx) {
        const id = await ctx.services.voice.unlock(ctx.actor.userId);
        return ok(`🔓 <#${id}> is open to everyone.`);
      },
    }),
    defineCommand({
      name: 'limit',
      description: 'Set the user limit (0 = unlimited)',
      node: 'voice:limit',
      options: { limit: opt.integer({ description: 'Max users (0-99)', required: true, min: 0, max: 99 }) },
      async execute(ctx, input) {
        const id = await ctx.services.voice.setLimit(ctx.actor.userId, input.limit);
        return ok(input.limit ? `<#${id}> now allows ${input.limit} users.` : `<#${id}> has no user limit.`);
      },
    }),
    defineCommand({
      name: 'rename',
      description: 'Rename your channel (Discord allows 2 renames per 10 minutes)',
      node: 'voice:rename',
      options: {
        name: opt.string({ description: 'New name', required: true, minLength: 1, maxLength: 100 }),
      },
      async execute(ctx, input) {
        const id = await ctx.services.voice.rename(ctx.actor.userId, input.name);
        return ok(`Renamed to <#${id}>.`);
      },
    }),
    defineCommand({
      name: 'invite',
      description: 'Let a member join even when locked or private',
      node: 'voice:invite',
      options: { user: memberOpt('Member to invite') },
      async execute(ctx, input) {
        const id = await ctx.services.voice.invite(ctx.actor.userId, input.user);
        return ok(`<@${input.user}> can now join <#${id}>.`);
      },
    }),
    defineCommand({
      name: 'kick',
      description: 'Remove a member and block them from rejoining',
      node: 'voice:kick',
      options: { user: memberOpt('Member to kick') },
      async execute(ctx, input) {
        const { channelId, disconnected } = await ctx.services.voice.kick(ctx.actor.userId, input.user);
        return ok(
          disconnected
            ? `Removed <@${input.user}> from <#${channelId}>; they can't rejoin.`
            : `<@${input.user}> is blocked from <#${channelId}>.`,
        );
      },
    }),
    defineCommand({
      name: 'transfer',
      description: 'Give ownership to someone in your channel',
      node: 'voice:transfer',
      options: { user: memberOpt('New owner') },
      async execute(ctx, input) {
        const id = await ctx.services.voice.transfer(ctx.actor.userId, input.user);
        return ok(`👑 <@${input.user}> now owns <#${id}>.`);
      },
    }),
    defineCommand({
      name: 'claim',
      description: 'Take ownership of a channel whose owner left',
      node: 'voice:claim',
      options: {},
      async execute(ctx) {
        const id = await ctx.services.voice.claim(ctx.actor.userId);
        return ok(`👑 You now own <#${id}>.`);
      },
    }),
  ],
});

export const voiceCommands = [voiceCommand, vcCommand];
