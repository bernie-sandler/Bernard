import { Cron } from 'croner';
import type { Logger } from '../logger.js';

export interface JobStatus {
  name: string;
  pattern: string;
  lastRunAt: Date | null;
  lastDurationMs: number | null;
  lastError: string | null;
  nextRunAt: Date | null;
}

/** Cron-based job runner: no overlapping runs, errors logged instead of thrown. */
export class Scheduler {
  private readonly jobs = new Map<string, { cron: Cron; status: JobStatus }>();

  constructor(private readonly logger: Logger) {}

  add(
    name: string,
    pattern: string,
    fn: () => Promise<unknown> | unknown,
    opts: { runOnStart?: boolean } = {},
  ): void {
    if (this.jobs.has(name)) throw new Error(`Job ${name} already registered`);
    const status: JobStatus = {
      name,
      pattern,
      lastRunAt: null,
      lastDurationMs: null,
      lastError: null,
      nextRunAt: null,
    };
    const run = async () => {
      const started = Date.now();
      status.lastRunAt = new Date(started);
      try {
        const result = await fn();
        status.lastError = null;
        this.logger.debug({ job: name, result, ms: Date.now() - started }, 'Job finished');
      } catch (err) {
        status.lastError = err instanceof Error ? err.message : String(err);
        this.logger.error({ err, job: name }, 'Job failed');
      } finally {
        status.lastDurationMs = Date.now() - started;
      }
    };
    const cron = new Cron(pattern, { protect: true, name }, run);
    status.nextRunAt = cron.nextRun();
    this.jobs.set(name, { cron, status });
    if (opts.runOnStart) void cron.trigger();
  }

  /** Run a job now (e.g. /tiers sync). Skipped if it is already running. */
  async trigger(name: string): Promise<void> {
    const job = this.jobs.get(name);
    if (!job) throw new Error(`Unknown job ${name}`);
    await job.cron.trigger();
  }

  status(): JobStatus[] {
    return [...this.jobs.values()].map(({ cron, status }) => ({ ...status, nextRunAt: cron.nextRun() }));
  }

  stop(): void {
    for (const { cron } of this.jobs.values()) cron.stop();
    this.jobs.clear();
  }
}
