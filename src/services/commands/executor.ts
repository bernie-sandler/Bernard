import { describeDiscordError } from '../../discord/errors.js';
import type { Logger } from '../../logger.js';
import { formatDuration, type OptionDescriptor } from '../../shared/commandOptions.js';
import { COLORS, type CommandResult } from '../../shared/commandResult.js';
import type { Services } from '../container.js';
import { isUserError } from '../errors.js';
import type { FlatCommand } from './registry.js';
import type { Actor, CommandContext, CommandSource } from './types.js';

export type Outcome = 'ok' | 'failed' | 'denied' | 'invalid' | 'error';

export interface RunRequest {
  command: FlatCommand;
  actor: Actor;
  source: CommandSource;
  channelId?: string;
  rawInput: Record<string, unknown>;
  /** Called once the permission check passes, before validation/execution (slash handler defers here). */
  onAllowed?: () => void;
}

export interface RunResponse {
  result: CommandResult;
  outcome: Outcome;
}

/**
 * The single execution path for commands, used by both the slash handler and the dashboard:
 * permission check → input validation → execute → commands log.
 */
export class CommandExecutor {
  constructor(
    private readonly services: Services,
    private readonly logger: Logger,
  ) {}

  async run(req: RunRequest): Promise<RunResponse> {
    const { command, actor, source } = req;
    const { leaf } = command;

    if (source === 'dashboard' && leaf.dashboard === false) {
      return this.finish(req, 'invalid', {
        ok: false,
        content: `/${command.fullName} can only be used in Discord.`,
      });
    }

    const decision = this.services.permissions.check(actor, leaf.node);
    if (!decision.allowed) {
      return this.finish(req, 'denied', {
        ok: false,
        ephemeral: true,
        content: `You don't have permission (\`${leaf.node}\`).`,
      });
    }
    req.onAllowed?.();

    // Options like purge's channel default to the channel the slash command was used in.
    const rawInput = { ...req.rawInput };
    if (req.channelId) {
      for (const [name, d] of Object.entries(leaf.options)) {
        if (
          d.kind === 'channel' &&
          d.contextDefault === 'current' &&
          (rawInput[name] === undefined || rawInput[name] === null)
        ) {
          rawInput[name] = req.channelId;
        }
      }
    }
    const parsed = command.schema.safeParse(rawInput);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `• \`${i.path.join('.') || 'input'}\`: ${i.message}`);
      return this.finish(req, 'invalid', {
        ok: false,
        ephemeral: true,
        content: `Invalid input:\n${issues.join('\n')}`,
      });
    }

    const ctx: CommandContext = {
      guildId: this.services.guild.guildId,
      actor,
      source,
      services: this.services,
      ...(req.channelId ? { channelId: req.channelId } : {}),
    };

    try {
      const result = await leaf.execute(ctx, parsed.data as never);
      return this.finish(req, result.ok ? 'ok' : 'failed', result);
    } catch (err) {
      if (isUserError(err)) {
        return this.finish(req, 'failed', { ok: false, ephemeral: true, content: err.message });
      }
      const discordMsg = describeDiscordError(err);
      if (discordMsg) {
        this.logger.warn({ err, command: command.fullName }, 'Discord API error during command');
        return this.finish(req, 'failed', { ok: false, ephemeral: true, content: discordMsg });
      }
      this.logger.error({ err, command: command.fullName, actor: actor.userId }, 'Command threw');
      return this.finish(req, 'error', {
        ok: false,
        ephemeral: true,
        content: 'Something went wrong running that command. The error has been logged.',
      });
    }
  }

  private async finish(req: RunRequest, outcome: Outcome, result: CommandResult): Promise<RunResponse> {
    const { command, actor, source } = req;
    const args = formatArgs(command.leaf.options, req.rawInput);
    const allowed = outcome !== 'denied';
    const label = allowed ? 'used' : 'was denied';
    // Not awaited: posting to the log channel is a Discord API call, and the user's reply shouldn't wait
    // on it (slash commands must be answered within 3s). The database row is written synchronously.
    this.services.logs
      .record({
        type: 'commands',
        event: allowed ? 'command_used' : 'command_denied',
        actorId: actor.userId,
        channelId: req.channelId ?? null,
        summary: `${actor.displayName} ${label} /${command.fullName}${args ? ` ${args}` : ''} (${source})`,
        data: {
          command: command.fullName,
          node: command.leaf.node,
          args: req.rawInput,
          allowed,
          outcome,
          source,
          ...(result.ok ? {} : { error: result.content }),
        },
        embed: {
          title: allowed ? 'Command used' : 'Command denied',
          color: !allowed ? COLORS.danger : outcome === 'ok' ? COLORS.success : COLORS.warning,
          fields: [
            { name: 'User', value: `<@${actor.userId}>`, inline: true },
            { name: 'Command', value: `\`/${command.fullName}\``, inline: true },
            { name: 'Source', value: source, inline: true },
            ...(args ? [{ name: 'Arguments', value: args.slice(0, 1024) }] : []),
            ...(req.channelId ? [{ name: 'Channel', value: `<#${req.channelId}>`, inline: true }] : []),
            { name: 'Outcome', value: outcome, inline: true },
          ],
        },
      })
      .catch((err) => this.logger.error({ err }, 'Failed to write commands log'));
    return { result, outcome };
  }
}

/** Render raw arguments for logs: mentions for IDs, readable durations, truncated strings. */
export function formatArgs(options: Record<string, OptionDescriptor>, raw: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [name, d] of Object.entries(options)) {
    const v = raw[name];
    if (v === undefined || v === null || v === '') continue;
    let shown: string;
    switch (d.kind) {
      case 'user':
        shown = `<@${String(v)}>`;
        break;
      case 'role':
        shown = `<@&${String(v)}>`;
        break;
      case 'channel':
        shown = `<#${String(v)}>`;
        break;
      case 'duration':
        shown = typeof v === 'number' ? formatDuration(v) : String(v);
        break;
      default: {
        const s = String(v);
        shown = s.length > 200 ? `${s.slice(0, 197)}...` : s;
      }
    }
    parts.push(`${name}:${shown}`);
  }
  return parts.join(' ');
}
