import pino, { type Logger } from 'pino';

export type { Logger };

export function createLogger(opts: { level: string; pretty: boolean }): Logger {
  return pino({
    level: opts.level,
    base: { app: 'bernard' },
    redact: {
      paths: ['token', '*.token', 'headers.authorization', 'headers.cookie', '*.secret', 'access_token'],
      censor: '[redacted]',
    },
    ...(opts.pretty
      ? { transport: { target: 'pino-pretty', options: { translateTime: 'SYS:HH:MM:ss' } } }
      : {}),
  });
}

/** Silent logger for tests. */
export const nullLogger: Logger = pino({ level: 'silent' });
