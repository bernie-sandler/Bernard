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

  return scheduler;
}
