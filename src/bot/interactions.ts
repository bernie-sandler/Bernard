import {
  ActionRowBuilder,
  type AutocompleteInteraction,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type GuildMember,
  type Interaction,
  type InteractionReplyOptions,
  MessageFlags,
  ModalBuilder,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { toEmbed, toMemberInfo, toMessagePayload } from '../discord/adapters.js';
import { describeDiscordError } from '../discord/errors.js';
import type { Logger } from '../logger.js';
import { REPORT_BUTTON_ID, REPORT_MODAL_ID } from '../services/belltower/service.js';
import type { CommandExecutor } from '../services/commands/executor.js';
import type { FlatCommand } from '../services/commands/registry.js';
import type { Actor } from '../services/commands/types.js';
import type { Services } from '../services/container.js';
import { isUserError } from '../services/errors.js';
import { parsePanelCustomId } from '../services/rolePanels.js';
import { parseCrazyVoteId } from '../services/thatsCrazy.js';
import type { CommandResult } from '../shared/commandResult.js';

export function actorFromMember(member: GuildMember): Actor {
  const info = toMemberInfo(member);
  return {
    userId: info.userId,
    username: info.username,
    displayName: info.displayName,
    roleIds: info.roleIds,
    isOwner: info.isOwner,
    isAdministrator: info.isAdministrator,
    highestRolePosition: info.highestRolePosition,
  };
}

function commandPath(i: ChatInputCommandInteraction | AutocompleteInteraction): string[] {
  const path = [i.commandName];
  const group = i.options.getSubcommandGroup(false);
  const sub = i.options.getSubcommand(false);
  if (group) path.push(group);
  if (sub) path.push(sub);
  return path;
}

/** Pull option values out of the interaction according to the command's descriptors. */
export function extractRawInput(
  i: ChatInputCommandInteraction,
  command: FlatCommand,
): Record<string, unknown> {
  const raw: Record<string, unknown> = {};
  for (const [name, d] of Object.entries(command.leaf.options)) {
    let value: unknown;
    switch (d.kind) {
      case 'user':
        value = i.options.getUser(name)?.id;
        break;
      case 'role':
        value = i.options.getRole(name)?.id;
        break;
      case 'channel':
        value = i.options.getChannel(name)?.id ?? (d.contextDefault === 'current' ? i.channelId : undefined);
        break;
      case 'integer':
        value = i.options.getInteger(name);
        break;
      case 'number':
        value = i.options.getNumber(name);
        break;
      case 'boolean':
        value = i.options.getBoolean(name);
        break;
      default:
        value = i.options.getString(name);
    }
    if (value !== null && value !== undefined) raw[name] = value;
  }
  return raw;
}

function toReply(result: CommandResult, ephemeral: boolean): InteractionReplyOptions {
  return {
    ...(result.content ? { content: result.content.slice(0, 2000) } : {}),
    embeds: (result.embeds ?? []).slice(0, 10).map(toEmbed),
    allowedMentions: { parse: [] },
    ...(ephemeral ? { flags: MessageFlags.Ephemeral } : {}),
  };
}

export function createInteractionHandler(deps: {
  services: Services;
  executor: CommandExecutor;
  logger: Logger;
}) {
  const { services, executor, logger } = deps;

  async function handleChatInput(i: ChatInputCommandInteraction): Promise<void> {
    const command = services.registry.find(commandPath(i));
    if (!command) {
      await i.reply({ content: 'Unknown command. It may have been removed.', flags: MessageFlags.Ephemeral });
      return;
    }
    if (!i.inCachedGuild() || i.guildId !== services.guild.guildId) {
      await i.reply({ content: 'This bot only works in its home server.', flags: MessageFlags.Ephemeral });
      return;
    }
    const leafEphemeral = command.leaf.ephemeral !== false;
    const receivedAt = Date.now();
    let deferred: Promise<unknown> | null = null;

    try {
      const { result } = await executor.run({
        command,
        actor: actorFromMember(i.member),
        source: 'slash',
        channelId: i.channelId,
        rawInput: extractRawInput(i, command),
        onAllowed: () => {
          // Acknowledge as soon as the permission check passes: Discord drops interactions that aren't
          // answered within 3s, and network latency can eat most of that before we even see it.
          // Denials skip this so they can still reply ephemerally.
          deferred = i.deferReply(leafEphemeral ? { flags: MessageFlags.Ephemeral } : {});
          deferred.catch(() => {}); // surfaced when awaited below
        },
      });
      const ephemeral = result.ephemeral ?? (!result.ok || leafEphemeral);
      if (deferred) {
        await deferred;
        if (ephemeral && !leafEphemeral) {
          // Deferred publicly but the result must be private: swap the placeholder for a private follow-up.
          await i.deleteReply().catch(() => {});
          await i.followUp(toReply(result, true));
        } else {
          const { flags: _flags, ...rest } = toReply(result, false);
          await i.editReply(rest);
        }
      } else {
        await i.reply(toReply(result, ephemeral));
      }
    } catch (err) {
      logger.error(
        {
          err,
          command: command.fullName,
          // How old the interaction was when it reached us, and how long we spent on it. A large
          // ageOnArrivalMs points at gateway/network lag (or a skewed host clock), not the bot.
          ageOnArrivalMs: receivedAt - i.createdTimestamp,
          handlingMs: Date.now() - receivedAt,
        },
        'Failed to respond to interaction',
      );
      const msg = { content: 'Something went wrong.', flags: MessageFlags.Ephemeral } as const;
      if (i.deferred || i.replied) await i.followUp(msg).catch(() => {});
      else await i.reply(msg).catch(() => {});
    }
  }

  async function handleAutocomplete(i: AutocompleteInteraction): Promise<void> {
    const command = services.registry.find(commandPath(i));
    const focused = i.options.getFocused(true);
    const handlers = command?.leaf.autocomplete;
    const handler = handlers && Object.hasOwn(handlers, focused.name) ? handlers[focused.name] : undefined;
    if (!command || !handler || !i.inCachedGuild()) {
      await i.respond([]);
      return;
    }
    try {
      const choices = await handler(
        { guildId: services.guild.guildId, actor: actorFromMember(i.member), services },
        String(focused.value ?? ''),
      );
      await i.respond(choices.slice(0, 25));
    } catch (err) {
      logger.warn({ err, command: command.fullName }, 'Autocomplete failed');
      await i.respond([]).catch(() => {});
    }
  }

  /** Role panel buttons and menus. Anyone who can see the panel may use it. */
  async function handleRolePanel(i: ButtonInteraction | StringSelectMenuInteraction): Promise<void> {
    const parsed = parsePanelCustomId(i.customId);
    if (!parsed) return; // not ours
    if (!i.inCachedGuild() || i.guildId !== services.guild.guildId) {
      await i.reply({ content: 'This panel only works in its home server.', flags: MessageFlags.Ephemeral });
      return;
    }
    // Acknowledge first: role changes are API calls and Discord allows only 3s for the first reply.
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    let content: string;
    try {
      content =
        parsed.kind === 'button'
          ? await services.rolePanels.handleButton(i.user.id, parsed.panelId, parsed.roleId)
          : await services.rolePanels.handleSelect(
              i.user.id,
              parsed.panelId,
              i.isStringSelectMenu() ? i.values : [],
            );
    } catch (err) {
      const readable = isUserError(err) ? err.message : describeDiscordError(err);
      if (!readable) logger.error({ err, customId: i.customId }, 'Role panel interaction failed');
      content = readable ?? 'Something went wrong.';
    }
    await i.editReply({ content, allowedMentions: { parse: [] } });
  }

  /** The vote button on a that's crazy poll. Same rule as the command (public:thatscrazy). */
  async function handleCrazyVote(i: ButtonInteraction, pollId: number): Promise<void> {
    if (!i.inCachedGuild() || i.guildId !== services.guild.guildId) return;
    if (!services.permissions.check(actorFromMember(i.member), 'public:thatscrazy').allowed) {
      await i.reply({
        content: "You don't have permission (`public:thatscrazy`).",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    let content: string;
    try {
      content = await services.thatsCrazy.vote(pollId, i.user.id);
    } catch (err) {
      const readable = isUserError(err) ? err.message : describeDiscordError(err);
      if (!readable) logger.error({ err, pollId }, "That's crazy vote failed");
      content = readable ?? 'Something went wrong.';
    }
    await i.editReply({ content, allowedMentions: { parse: [] } });
  }

  /**
   * The report panel's button: open the report form, or in link mode reply with the member's own
   * submit page link. A modal must be the first reply, so no defer.
   */
  async function handleReportButton(i: ButtonInteraction): Promise<void> {
    if (!i.inCachedGuild() || i.guildId !== services.guild.guildId) {
      await i.reply({ content: 'This panel only works in its home server.', flags: MessageFlags.Ephemeral });
      return;
    }
    // Say no before the form, not after the member filled it in.
    const blocked = services.permissions.check(actorFromMember(i.member), 'public:report').allowed
      ? services.belltower.unavailableReason()
      : "You don't have permission (`public:report`).";
    if (blocked) {
      await i.reply({ content: blocked, flags: MessageFlags.Ephemeral });
      return;
    }
    // Link mode: hand over the member's own link to Belltower's submit page instead of a form.
    if (services.settings.get().belltower.mode === 'link') {
      const { text, url } = services.belltower.linkPrompt(i.user.id, i.channelId);
      const { components } = toMessagePayload({
        buttons: url ? [{ url, label: 'Open the request form', emoji: '🛎️' }] : [],
      });
      await i.reply({
        content: text,
        components,
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      });
      return;
    }
    const service = new TextInputBuilder()
      .setCustomId('service')
      .setLabel("What isn't working?")
      .setPlaceholder('e.g. Plex')
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setMaxLength(100);
    const details = new TextInputBuilder()
      .setCustomId('details')
      .setLabel('Details')
      .setPlaceholder('What happens, error messages, since when')
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(false)
      .setMaxLength(1000);
    await i.showModal(
      new ModalBuilder()
        .setCustomId(REPORT_MODAL_ID)
        .setTitle('Report an issue')
        .addComponents(
          new ActionRowBuilder<TextInputBuilder>().addComponents(service),
          new ActionRowBuilder<TextInputBuilder>().addComponents(details),
        ),
    );
  }

  /** The submitted report form. Same rules as /report (public:report). */
  async function handleReportModal(i: ModalSubmitInteraction): Promise<void> {
    if (!i.inCachedGuild() || i.guildId !== services.guild.guildId) return;
    const actor = actorFromMember(i.member);
    if (!services.permissions.check(actor, 'public:report').allowed) {
      await i.reply({
        content: "You don't have permission (`public:report`).",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    let content: string;
    try {
      content = await services.belltower.report(
        { userId: actor.userId, username: actor.username, displayName: actor.displayName },
        {
          service: i.fields.getTextInputValue('service'),
          details: i.fields.getTextInputValue('details'),
          channelId: i.channelId,
        },
      );
    } catch (err) {
      if (!isUserError(err)) logger.error({ err }, 'Report from the panel failed');
      content = isUserError(err) ? err.message : 'Something went wrong.';
    }
    await i.editReply({ content, allowedMentions: { parse: [] } });
  }

  return async (interaction: Interaction): Promise<void> => {
    try {
      if (interaction.isChatInputCommand()) await handleChatInput(interaction);
      else if (interaction.isAutocomplete()) await handleAutocomplete(interaction);
      else if (interaction.isButton() && parseCrazyVoteId(interaction.customId) !== null) {
        await handleCrazyVote(interaction, parseCrazyVoteId(interaction.customId) as number);
      } else if (interaction.isButton() && interaction.customId === REPORT_BUTTON_ID) {
        await handleReportButton(interaction);
      } else if (interaction.isModalSubmit() && interaction.customId === REPORT_MODAL_ID) {
        await handleReportModal(interaction);
      } else if (interaction.isButton() || interaction.isStringSelectMenu())
        await handleRolePanel(interaction);
    } catch (err) {
      logger.error({ err }, 'Interaction handler crashed');
    }
  };
}
