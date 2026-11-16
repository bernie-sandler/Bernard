import type { Logger } from '../logger.js';
import type { Services } from '../services/container.js';
import { Scheduler } from './scheduler.js';

/** Register every recurring job. Called once the bot is connected. */
export function startJobs(services: Services, logger: Logger): Scheduler {
  const scheduler = new Scheduler(logger.child({ component: 'jobs' }));

  // Lift expired temporary bans.
  scheduler.add('scheduled-actions', '* * * * *', () => services.moderation.processDueUnbans(), {
    runOnStart: true,
  });

  // Prune stored logs older than the retention period.
  scheduler.add('log-retention', '30 3 * * *', () => services.logs.prune(), { runOnStart: true });

  // Award voice minutes to everyone eligible.
  scheduler.add('voice-minutes', '* * * * *', () => {
    const { channels, afkChannelId } = services.voice.activitySnapshot();
    return services.activity.voiceTick(channels, afkChannelId).length;
  });

  // Full tier sync whenever the configured interval has passed (checked every minute so changes to
  // the interval apply without a restart).
  scheduler.add('tier-sync', '* * * * *', () => services.tiers.maybeScheduledSync());

  // Drop daily activity rows older than the history kept for charts.
  scheduler.add('activity-retention', '45 3 * * *', () => services.activity.prune(), { runOnStart: true });

  return scheduler;
}
