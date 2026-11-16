import { createHash } from 'node:crypto';
import {
  type APIApplicationCommandBasicOption,
  type APIApplicationCommandOption,
  ApplicationCommandOptionType,
  ApplicationCommandType,
  ChannelType,
  InteractionContextType,
  type RESTPostAPIChatInputApplicationCommandsJSONBody,
} from 'discord.js';
import { type CommandDefinition, isLeaf, type LeafCommand } from '../services/commands/types.js';
import type { ChannelKind, OptionDescriptor } from '../shared/commandOptions.js';

const CHANNEL_TYPES: Record<ChannelKind, ChannelType[]> = {
  text: [ChannelType.GuildText],
  voice: [ChannelType.GuildVoice],
  category: [ChannelType.GuildCategory],
  announcement: [ChannelType.GuildAnnouncement],
  stage: [ChannelType.GuildStageVoice],
  forum: [ChannelType.GuildForum],
};

/** Convert one option descriptor to Discord's JSON shape. */
export function optionToJson(name: string, d: OptionDescriptor): APIApplicationCommandBasicOption {
  // Context-default channels are optional in Discord; the handler fills in the current channel.
  const base = { name, description: d.description, required: d.required };
  switch (d.kind) {
    case 'string':
      return {
        ...base,
        type: ApplicationCommandOptionType.String,
        ...(d.minLength !== undefined ? { min_length: d.minLength } : {}),
        max_length: Math.min(d.maxLength ?? 6000, 6000),
        ...(d.choices?.length ? { choices: d.choices } : {}),
        ...(d.autocomplete ? { autocomplete: true } : {}),
      } as APIApplicationCommandBasicOption;
    case 'duration':
      return { ...base, type: ApplicationCommandOptionType.String, max_length: 32 };
    case 'integer':
      return {
        ...base,
        type: ApplicationCommandOptionType.Integer,
        ...(d.min !== undefined ? { min_value: d.min } : {}),
        ...(d.max !== undefined ? { max_value: d.max } : {}),
        ...(d.choices?.length ? { choices: d.choices } : {}),
      } as APIApplicationCommandBasicOption;
    case 'number':
      return {
        ...base,
        type: ApplicationCommandOptionType.Number,
        ...(d.min !== undefined ? { min_value: d.min } : {}),
        ...(d.max !== undefined ? { max_value: d.max } : {}),
      };
    case 'boolean':
      return { ...base, type: ApplicationCommandOptionType.Boolean };
    case 'user':
      return { ...base, type: ApplicationCommandOptionType.User };
    case 'role':
      return { ...base, type: ApplicationCommandOptionType.Role };
    case 'channel':
      return {
        ...base,
        type: ApplicationCommandOptionType.Channel,
        ...(d.channelTypes?.length
          ? { channel_types: d.channelTypes.flatMap((k) => CHANNEL_TYPES[k]) as never }
          : {}),
      };
  }
}

/** Discord requires required options before optional ones. */
function optionsToJson(leaf: LeafCommand): APIApplicationCommandBasicOption[] {
  const entries = Object.entries(leaf.options);
  const required = entries.filter(([, d]) => d.required);
  const optional = entries.filter(([, d]) => !d.required);
  return [...required, ...optional].map(([name, d]) => optionToJson(name, d));
}

function subcommandJson(leaf: LeafCommand): APIApplicationCommandOption {
  return {
    type: ApplicationCommandOptionType.Subcommand,
    name: leaf.name,
    description: leaf.description,
    options: optionsToJson(leaf),
  };
}

/**
 * Build the registration payload for one top-level command. Deliberately no
 * default_member_permissions: the bot enforces its own permission system at execution time,
 * so Discord must not hide commands from anyone.
 */
export function commandToJson(def: CommandDefinition): RESTPostAPIChatInputApplicationCommandsJSONBody {
  const base = {
    type: ApplicationCommandType.ChatInput as const,
    name: def.name,
    description: def.description,
    contexts: [InteractionContextType.Guild],
  };
  if (isLeaf(def)) return { ...base, options: optionsToJson(def) };
  return {
    ...base,
    options: [
      ...(def.subcommands ?? []).map(subcommandJson),
      ...(def.groups ?? []).map((g) => ({
        type: ApplicationCommandOptionType.SubcommandGroup as const,
        name: g.name,
        description: g.description,
        options: g.subcommands.map(subcommandJson) as never,
      })),
    ],
  };
}

export function buildRegistrationPayload(defs: readonly CommandDefinition[]) {
  const body = defs.map(commandToJson);
  const hash = createHash('sha256').update(JSON.stringify(body)).digest('hex');
  return { body, hash };
}
