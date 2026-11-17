import { type Client, Events } from 'discord.js';
import { toMemberInfo } from '../../discord/adapters.js';
import type { Logger } from '../../logger.js';
import type { Services } from '../../services/container.js';

const LINK = /https?:\/\/\S/i;

/**
 * Messages (with image and link bonuses) and reactions (given and received) earn activity points;
 * joins/leaves/profile changes keep the members table current.
 */
export function registerActivityEvents(client: Client, services: Services, logger: Logger): void {
  const guildId = services.guild.guildId;
  const safe =
    <A extends unknown[]>(name: string, fn: (...args: A) => Promise<void> | void) =>
    async (...args: A) => {
      try {
        await fn(...args);
      } catch (err) {
        logger.error({ err, event: name }, 'Activity event handler failed');
      }
    };

  client.on(
    Events.MessageCreate,
    safe('activity:messageCreate', (m) => {
      if (m.guildId !== guildId || m.author.bot || m.system || m.webhookId) return;
      services.activity.recordMessage(m.author.id, {
        image: m.attachments.some((a) => a.contentType?.startsWith('image/') ?? false),
        link: LINK.test(m.content),
      });
    }),
  );

  client.on(
    Events.MessageReactionAdd,
    safe('activity:reactionAdd', async (reaction, user) => {
      if (reaction.message.guildId !== guildId || user.bot) return;
      const message = reaction.message.partial ? await reaction.message.fetch() : reaction.message;
      const author = message.author;
      services.activity.recordReaction({
        reactorId: user.id,
        // Bots, webhooks and system messages don't earn received points.
        authorId: author && !author.bot && !message.webhookId && !message.system ? author.id : null,
        messageId: message.id,
        messageCreatedAt: message.createdTimestamp,
      });
    }),
  );

  client.on(
    Events.GuildMemberAdd,
    safe('activity:memberAdd', (member) => {
      if (member.guild.id !== guildId) return;
      services.members.recordJoin(toMemberInfo(member), member.joinedAt ?? new Date());
      // Tenure-0 tiers apply straight away.
      if (!member.user.bot) services.tiers.queueEvaluate(member.id);
    }),
  );

  client.on(
    Events.GuildMemberRemove,
    safe('activity:memberRemove', (member) => {
      if (member.guild.id !== guildId) return;
      services.members.recordLeave(member.id);
    }),
  );

  client.on(
    Events.GuildMemberUpdate,
    safe('activity:memberUpdate', (oldMember, newMember) => {
      if (newMember.guild.id !== guildId) return;
      if (
        oldMember.partial ||
        oldMember.displayName !== newMember.displayName ||
        oldMember.user.username !== newMember.user.username ||
        oldMember.avatar !== newMember.avatar
      ) {
        services.members.updateProfile(toMemberInfo(newMember));
      }
    }),
  );
}
