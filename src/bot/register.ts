import { REST, Routes } from 'discord.js';
import type { Logger } from '../logger.js';
import type { BotStateStore } from '../services/botState.js';
import type { CommandDefinition } from '../services/commands/types.js';
import { buildRegistrationPayload } from './slashJson.js';

/**
 * Register guild-scoped slash commands (they update instantly, unlike global ones).
 * Skips the API call when the payload hash matches the last successful registration.
 */
export async function registerCommands(opts: {
  token: string;
  clientId: string;
  guildId: string;
  definitions: readonly CommandDefinition[];
  state: BotStateStore;
  logger: Logger;
  force?: boolean;
}): Promise<'registered' | 'unchanged'> {
  const { body, hash } = buildRegistrationPayload(opts.definitions);
  const stateKey = `command_hash:${opts.clientId}`;
  if (!opts.force && opts.state.get(stateKey) === hash) {
    opts.logger.info({ commands: body.length }, 'Slash commands unchanged; skipping registration');
    return 'unchanged';
  }
  const rest = new REST().setToken(opts.token);
  await rest.put(Routes.applicationGuildCommands(opts.clientId, opts.guildId), { body });
  opts.state.set(stateKey, hash);
  opts.logger.info({ commands: body.length }, 'Registered slash commands');
  return 'registered';
}
