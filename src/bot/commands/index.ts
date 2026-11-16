import type { CommandDefinition } from '../../services/commands/types.js';
import { coreCommands } from './core.js';
import { permissionCommands } from './permissions.js';

/** Every command the bot registers. Add new command modules here. */
export const allCommands: CommandDefinition[] = [...coreCommands, ...permissionCommands];
