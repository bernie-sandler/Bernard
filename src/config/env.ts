import { z } from 'zod';

const snowflake = z.string().regex(/^\d{17,20}$/, 'must be a Discord ID (17-20 digits)');

const boolString = z
  .enum(['true', 'false', '1', '0', 'yes', 'no'])
  .transform((v) => v === 'true' || v === '1' || v === 'yes');

/**
 * TRUST_PROXY accepts:
 *  - "false" / "true"
 *  - a hop count, e.g. "1"
 *  - a comma-separated list of IPs/CIDRs, e.g. "172.16.0.0/12,10.0.0.1"
 */
const trustProxy = z
  .string()
  .default('false')
  .transform((v): boolean | number | string[] => {
    const t = v.trim().toLowerCase();
    if (t === 'true') return true;
    if (t === 'false' || t === '') return false;
    if (/^\d+$/.test(t)) return Number(t);
    return v
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  });

export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'production', 'test']).default('production'),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
    LOG_PRETTY: boolString.default(false),

    DISCORD_TOKEN: z.string().min(50, 'looks too short to be a bot token'),
    DISCORD_CLIENT_ID: snowflake,
    GUILD_ID: snowflake,

    DATABASE_PATH: z.string().min(1).default('/data/bernard.db'),
    MIGRATIONS_DIR: z.string().min(1).default('src/db/migrations'),

    HOST: z.string().default('0.0.0.0'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    PUBLIC_BASE_URL: z
      .url()
      .default('http://localhost:3000')
      .transform((u) => u.replace(/\/+$/, '')),
    TRUST_PROXY: trustProxy,

    DASHBOARD_ENABLED: boolString.default(true),
    DISCORD_CLIENT_SECRET: z.string().optional(),
    SESSION_SECRET: z.string().optional(),
    SESSION_TTL_HOURS: z.coerce
      .number()
      .int()
      .min(1)
      .max(24 * 90)
      .default(168),
    COOKIE_SECURE: boolString.optional(),

    /** Belltower (issue reports). Both or neither; unset turns /report off. */
    BELLTOWER_URL: z
      .url({ protocol: /^https?$/, error: 'must be an http(s) URL' })
      .optional()
      .or(z.literal('').transform(() => undefined))
      .transform((u) => u?.replace(/\/+$/, '')),
    BELLTOWER_TOKEN: z
      .string()
      .regex(/^tt_\S+$/, 'must be a Belltower API token (starts with tt_)')
      .optional()
      .or(z.literal('').transform(() => undefined)),
  })
  .superRefine((env, ctx) => {
    for (const issue of dashboardIssues(env)) ctx.addIssue({ code: 'custom', ...issue });
    if (Boolean(env.BELLTOWER_URL) !== Boolean(env.BELLTOWER_TOKEN)) {
      const missing = env.BELLTOWER_URL ? 'BELLTOWER_TOKEN' : 'BELLTOWER_URL';
      ctx.addIssue({
        code: 'custom',
        path: [missing],
        message: 'set BELLTOWER_URL and BELLTOWER_TOKEN together',
      });
    }
  })
  .transform((env) => ({
    ...env,
    COOKIE_SECURE: env.COOKIE_SECURE ?? env.PUBLIC_BASE_URL.startsWith('https://'),
  }));

export type Env = z.infer<typeof envSchema>;

/** Dashboard secrets are only required when the dashboard is on. */
function dashboardIssues(env: {
  DASHBOARD_ENABLED?: boolean;
  DISCORD_CLIENT_SECRET?: string | undefined;
  SESSION_SECRET?: string | undefined;
}): { path: string[]; message: string }[] {
  if (env.DASHBOARD_ENABLED === false) return [];
  const issues: { path: string[]; message: string }[] = [];
  if (!env.DISCORD_CLIENT_SECRET) {
    issues.push({ path: ['DISCORD_CLIENT_SECRET'], message: 'required when DASHBOARD_ENABLED=true' });
  }
  if (!env.SESSION_SECRET || env.SESSION_SECRET.length < 32) {
    issues.push({
      path: ['SESSION_SECRET'],
      message: 'must be at least 32 characters when DASHBOARD_ENABLED=true (try: openssl rand -hex 32)',
    });
  }
  return issues;
}

export class ConfigError extends Error {
  override name = 'ConfigError';
}

/** Parse and validate the environment. Throws a ConfigError listing every problem. */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const issues = result.error.issues.map((i) => ({ path: i.path.map(String), message: i.message }));
    // zod skips refinements when base fields fail, so check dashboard secrets separately to report everything at once.
    const enabledRaw = source.DASHBOARD_ENABLED?.toLowerCase();
    const extra = dashboardIssues({
      DASHBOARD_ENABLED: !(enabledRaw === 'false' || enabledRaw === '0' || enabledRaw === 'no'),
      DISCORD_CLIENT_SECRET: source.DISCORD_CLIENT_SECRET,
      SESSION_SECRET: source.SESSION_SECRET,
    }).filter((x) => !issues.some((i) => i.path.join('.') === x.path.join('.')));
    const lines = [...issues, ...extra].map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new ConfigError(`Invalid environment configuration:\n${lines.join('\n')}\nSee .env.example.`);
  }
  return result.data;
}
