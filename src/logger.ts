import { createRequire } from 'node:module';
import pino, { type Logger } from 'pino';

export type { Logger };

const require = createRequire(import.meta.url);

function prettyAvailable(): boolean {
  try {
    require.resolve('pino-pretty');
    return true;
  } catch {
    return false;
  }
}

export function createLogger(opts: { level: string; pretty: boolean }): Logger {
  // pino throws at construction if the transport target can't be resolved, so check first
  // and fall back to JSON logs rather than refusing to start.
  const pretty = opts.pretty && prettyAvailable();
  const logger = pino({
    level: opts.level,
    base: { app: 'bernard' },
    redact: {
      paths: ['token', '*.token', 'headers.authorization', 'headers.cookie', '*.secret', 'access_token'],
      censor: '[redacted]',
    },
    ...(pretty ? { transport: { target: 'pino-pretty', options: { translateTime: 'SYS:HH:MM:ss' } } } : {}),
  });
  if (opts.pretty && !pretty) {
    logger.warn('LOG_PRETTY=true but pino-pretty is not installed; falling back to JSON logs');
  }
  return logger;
}

/** Silent logger for tests. */
export const nullLogger: Logger = pino({ level: 'silent' });
