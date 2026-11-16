import { z } from 'zod';

/**
 * Declarative command option descriptors. One descriptor drives:
 *  - the Discord slash command JSON (src/bot/slashJson.ts)
 *  - the zod input schema (below), used by both slash and dashboard execution
 *  - the dashboard Command Runner form (descriptors are plain JSON)
 */

export type ChannelKind = 'text' | 'voice' | 'category' | 'announcement' | 'stage' | 'forum';

interface Base<R extends boolean> {
  description: string;
  required: R;
}

export interface StringOpt<R extends boolean = boolean> extends Base<R> {
  kind: 'string';
  minLength?: number;
  maxLength?: number;
  choices?: { name: string; value: string }[];
  autocomplete?: boolean;
  /** Render as a textarea in the dashboard. */
  multiline?: boolean;
}
export interface IntegerOpt<R extends boolean = boolean> extends Base<R> {
  kind: 'integer';
  min?: number;
  max?: number;
  choices?: { name: string; value: number }[];
}
export interface NumberOpt<R extends boolean = boolean> extends Base<R> {
  kind: 'number';
  min?: number;
  max?: number;
}
export interface BooleanOpt<R extends boolean = boolean> extends Base<R> {
  kind: 'boolean';
}
export interface UserOpt<R extends boolean = boolean> extends Base<R> {
  kind: 'user';
}
export interface RoleOpt<R extends boolean = boolean> extends Base<R> {
  kind: 'role';
}
export interface ChannelOpt<R extends boolean = boolean> extends Base<R> {
  kind: 'channel';
  channelTypes?: ChannelKind[];
  /**
   * 'current': in Discord the option is optional and defaults to the channel the command was used in.
   * On the dashboard there is no current channel, so the option is required there.
   */
  contextDefault?: 'current';
}
export interface DurationOpt<R extends boolean = boolean> extends Base<R> {
  kind: 'duration';
  /** Max duration in ms. */
  maxMs?: number;
  minMs?: number;
}

export type OptionDescriptor =
  | StringOpt
  | IntegerOpt
  | NumberOpt
  | BooleanOpt
  | UserOpt
  | RoleOpt
  | ChannelOpt
  | DurationOpt;

export type OptionsShape = Record<string, OptionDescriptor>;

type ValueOf<D extends OptionDescriptor> = D extends StringOpt
  ? string
  : D extends IntegerOpt | NumberOpt | DurationOpt
    ? number
    : D extends BooleanOpt
      ? boolean
      : string; // user / role / channel → snowflake ID

type IsRequired<D> = D extends { required: true }
  ? true
  : D extends { contextDefault: 'current' }
    ? true
    : false;

/** The validated input type a command's execute() receives. */
export type InferInput<O extends OptionsShape> = {
  [K in keyof O as IsRequired<O[K]> extends true ? K : never]: ValueOf<O[K]>;
} & {
  [K in keyof O as IsRequired<O[K]> extends true ? never : K]?: ValueOf<O[K]>;
};

// ── Builders ────────────────────────────────────────────────────────────────

type Params<T extends { kind: string; required: boolean }, R extends boolean> = Omit<
  T,
  'kind' | 'required'
> & {
  required?: R;
};

function make<K extends OptionDescriptor['kind']>(kind: K) {
  // NoInfer: infer `required` only from the argument, never from the contextual return type
  // (otherwise defineCommand's OptionsShape context widens it to `boolean`).
  return <R extends boolean = false>(
    params: Params<Extract<OptionDescriptor, { kind: K }>, R>,
  ): Extract<OptionDescriptor, { kind: K }> & { required: NoInfer<R> } =>
    ({ ...params, kind, required: (params.required ?? false) as R }) as Extract<
      OptionDescriptor,
      { kind: K }
    > & {
      required: R;
    };
}

export const opt = {
  string: make('string'),
  integer: make('integer'),
  number: make('number'),
  boolean: make('boolean'),
  user: make('user'),
  role: make('role'),
  channel: make('channel'),
  duration: make('duration'),
};

// ── Durations ───────────────────────────────────────────────────────────────

const UNIT_MS: Record<string, number> = {
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

/** Parse "90s", "10m", "1h30m", "2d", "1w" → ms. Returns null when invalid. */
export function parseDuration(input: string): number | null {
  const s = input.trim().toLowerCase().replace(/\s+/g, '');
  if (!s) return null;
  const re = /(\d+)([smhdw])/g;
  let total = 0;
  let consumed = 0;
  for (const m of s.matchAll(re)) {
    if (m.index !== consumed) return null;
    total += Number(m[1]) * UNIT_MS[m[2]!]!;
    consumed += m[0].length;
  }
  if (consumed !== s.length || total <= 0) return null;
  return total;
}

/** 5400000 → "1h 30m". */
export function formatDuration(ms: number): string {
  const parts: string[] = [];
  let rest = Math.round(ms / 1000);
  for (const [unit, sec] of [
    ['d', 86400],
    ['h', 3600],
    ['m', 60],
    ['s', 1],
  ] as const) {
    if (rest >= sec) {
      parts.push(`${Math.floor(rest / sec)}${unit}`);
      rest %= sec;
    }
  }
  return parts.join(' ') || '0s';
}

// ── zod schema generation ───────────────────────────────────────────────────

const snowflake = z.string().regex(/^\d{17,20}$/, 'must be a Discord ID');

function fieldSchema(d: OptionDescriptor): z.ZodType {
  switch (d.kind) {
    case 'string': {
      let s = z.string().trim();
      if (d.minLength !== undefined) s = s.min(d.minLength);
      s = s.max(d.maxLength ?? 6000);
      if (d.choices?.length) {
        const values = d.choices.map((c) => c.value);
        return s.refine((v) => values.includes(v), { message: `must be one of: ${values.join(', ')}` });
      }
      return s;
    }
    case 'integer':
    case 'number': {
      let n = d.kind === 'integer' ? z.coerce.number().int() : z.coerce.number();
      if (d.min !== undefined) n = n.min(d.min);
      if (d.max !== undefined) n = n.max(d.max);
      return n;
    }
    case 'boolean':
      return z.union([z.boolean(), z.enum(['true', 'false']).transform((v) => v === 'true')]);
    case 'user':
    case 'role':
    case 'channel':
      return snowflake;
    case 'duration':
      return z.union([z.number().int().positive(), z.string()]).transform((v, ctx) => {
        const ms = typeof v === 'number' ? v : parseDuration(v);
        if (ms === null) {
          ctx.addIssue({ code: 'custom', message: 'invalid duration (examples: 10m, 1h30m, 2d)' });
          return z.NEVER;
        }
        if (d.minMs !== undefined && ms < d.minMs) {
          ctx.addIssue({ code: 'custom', message: `must be at least ${formatDuration(d.minMs)}` });
          return z.NEVER;
        }
        if (d.maxMs !== undefined && ms > d.maxMs) {
          ctx.addIssue({ code: 'custom', message: `must be at most ${formatDuration(d.maxMs)}` });
          return z.NEVER;
        }
        return ms;
      });
  }
}

/**
 * Build the input schema for a set of options. Context-default channels are required here because
 * the caller (slash handler) fills them in before validation, and the dashboard must supply them.
 * Empty strings and nulls from forms are treated as "not provided".
 */
export function buildInputSchema<O extends OptionsShape>(options: O): z.ZodType<InferInput<O>> {
  const shape: Record<string, z.ZodType> = {};
  for (const [name, d] of Object.entries(options)) {
    const required = d.required || (d.kind === 'channel' && d.contextDefault === 'current');
    const base = fieldSchema(d);
    shape[name] = z.preprocess(
      (v) => (v === '' || v === null ? undefined : v),
      required ? base : base.optional(),
    );
  }
  return z.object(shape).strict() as unknown as z.ZodType<InferInput<O>>;
}
