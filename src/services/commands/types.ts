import type { InferInput, OptionsShape } from '../../shared/commandOptions.js';
import type { CommandResult } from '../../shared/commandResult.js';
import type { Services } from '../container.js';

export type CommandSource = 'slash' | 'dashboard';

/** The member running a command, resolved from Discord (slash) or the session (dashboard). */
export interface Actor {
  userId: string;
  username: string;
  displayName: string;
  /** Includes the @everyone role ID. */
  roleIds: string[];
  isOwner: boolean;
  isAdministrator: boolean;
  /** Position of the member's highest role (for hierarchy checks). */
  highestRolePosition: number;
}

export interface CommandContext {
  guildId: string;
  actor: Actor;
  source: CommandSource;
  /** The channel the slash command was used in. Undefined for dashboard runs. */
  channelId?: string;
  services: Services;
}

export interface AutocompleteContext {
  guildId: string;
  actor: Actor;
  services: Services;
}

export type AutocompleteHandler = (
  ctx: AutocompleteContext,
  focused: string,
) => Promise<{ name: string; value: string }[]> | { name: string; value: string }[];

export interface LeafCommand<O extends OptionsShape = OptionsShape> {
  name: string;
  description: string;
  /** Permission node checked before execution, e.g. "admin:ban". */
  node: string;
  options: O;
  /** Reply ephemerally in Discord (default true). Errors are always ephemeral. */
  ephemeral?: boolean;
  /** Offer this command in the dashboard Command Runner (default true). */
  dashboard?: boolean;
  autocomplete?: Partial<Record<keyof O & string, AutocompleteHandler>>;
  execute(ctx: CommandContext, input: InferInput<O>): Promise<CommandResult>;
}

export interface SubcommandGroup {
  name: string;
  description: string;
  subcommands: LeafCommand[];
}

export interface CommandTree {
  name: string;
  description: string;
  subcommands?: LeafCommand[];
  groups?: SubcommandGroup[];
}

export type CommandDefinition = LeafCommand | CommandTree;

export function isLeaf(def: CommandDefinition): def is LeafCommand {
  return 'execute' in def;
}

/** Identity helpers that keep option types inferred. */
export function defineCommand<O extends OptionsShape>(def: LeafCommand<O>): LeafCommand<O> {
  return def;
}
export function defineTree(def: CommandTree): CommandTree {
  return def;
}

export type { CommandResult };
