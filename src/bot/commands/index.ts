import type { CommandDefinition } from '../../services/commands/types.js';
import { coreCommands } from './core.js';
import { infoCommands } from './info.js';
import { logsCommand } from './logs.js';
import { moderationCommands } from './moderation.js';
import { permissionCommands } from './permissions.js';
import { voiceCommands } from './voice.js';

/** Every command the bot registers. Add new command modules here. */
export const allCommands: CommandDefinition[] = [
  ...coreCommands,
  ...infoCommands,
  ...permissionCommands,
  ...moderationCommands,
  logsCommand,
  ...voiceCommands,
];
