import { ApplicationCommandOptionType, ChannelType } from 'discord.js';
import { describe, expect, it } from 'vitest';
import { allCommands } from '../src/bot/commands/index.js';
import { buildRegistrationPayload, commandToJson } from '../src/bot/slashJson.js';
import { CommandRegistry } from '../src/services/commands/registry.js';
import { defineCommand, defineTree } from '../src/services/commands/types.js';
import { buildInputSchema, formatDuration, opt, parseDuration } from '../src/shared/commandOptions.js';
import { ok } from '../src/shared/commandResult.js';

const ID = '123456789012345678';

describe('durations', () => {
  it.each([
    ['90s', 90_000],
    ['10m', 600_000],
    ['1h30m', 5_400_000],
    ['2d', 172_800_000],
    ['1w', 604_800_000],
    [' 1h 5m ', 3_900_000],
  ])('parses %j', (input, ms) => {
    expect(parseDuration(input)).toBe(ms);
  });

  it.each(['', 'abc', '10', '5x', 'm10', '1h-5m', '0m'])('rejects %j', (input) => {
    expect(parseDuration(input)).toBeNull();
  });

  it('formats', () => {
    expect(formatDuration(5_400_000)).toBe('1h 30m');
    expect(formatDuration(0)).toBe('0s');
  });
});

describe('buildInputSchema', () => {
  const options = {
    user: opt.user({ description: 'u', required: true }),
    reason: opt.string({ description: 'r', maxLength: 10 }),
    amount: opt.integer({ description: 'a', min: 1, max: 100 }),
    duration: opt.duration({ description: 'd', maxMs: 28 * 86_400_000 }),
    channel: opt.channel({ description: 'c', contextDefault: 'current' }),
    flag: opt.boolean({ description: 'f' }),
    kind: opt.string({ description: 'k', choices: [{ name: 'A', value: 'a' }] }),
  };
  const schema = buildInputSchema(options);

  it('accepts valid input and converts durations to ms', () => {
    const r = schema.parse({ user: ID, channel: ID, duration: '1h', amount: '5', flag: 'true' });
    expect(r).toEqual({ user: ID, channel: ID, duration: 3_600_000, amount: 5, flag: true });
  });

  it('treats empty strings and nulls as missing', () => {
    expect(schema.parse({ user: ID, channel: ID, reason: '', amount: null })).toEqual({
      user: ID,
      channel: ID,
    });
  });

  it('requires context-default channels (the dashboard must send one)', () => {
    expect(schema.safeParse({ user: ID }).success).toBe(false);
  });

  it.each([
    [{ channel: ID }, 'missing required user'],
    [{ user: 'nope', channel: ID }, 'bad snowflake'],
    [{ user: ID, channel: ID, amount: 0 }, 'below min'],
    [{ user: ID, channel: ID, amount: 1.5 }, 'non-integer'],
    [{ user: ID, channel: ID, reason: 'x'.repeat(11) }, 'too long'],
    [{ user: ID, channel: ID, duration: '30d' }, 'duration above max'],
    [{ user: ID, channel: ID, duration: 'soon' }, 'unparseable duration'],
    [{ user: ID, channel: ID, kind: 'b' }, 'not a choice'],
    [{ user: ID, channel: ID, extra: 1 }, 'unknown key'],
  ])('rejects %j (%s)', (input: Record<string, unknown>, _label: string) => {
    expect(schema.safeParse(input).success).toBe(false);
  });
});

describe('slash JSON', () => {
  const leaf = defineCommand({
    name: 'demo',
    description: 'Demo',
    node: 'admin:demo',
    options: {
      reason: opt.string({ description: 'optional first' }),
      user: opt.user({ description: 'required second', required: true }),
      channel: opt.channel({
        description: 'c',
        channelTypes: ['text', 'announcement'],
        contextDefault: 'current',
      }),
      search: opt.string({ description: 's', autocomplete: true }),
      duration: opt.duration({ description: 'd' }),
    },
    execute: async () => ok('done'),
  });

  it('never sets default_member_permissions and is guild-only', () => {
    const json = commandToJson(leaf);
    expect(json).not.toHaveProperty('default_member_permissions');
    expect(json.contexts).toEqual([0]);
  });

  it('puts required options first and maps kinds', () => {
    const opts = commandToJson(leaf).options!;
    expect(opts.map((o) => o.name)).toEqual(['user', 'reason', 'channel', 'search', 'duration']);
    const channel = opts.find((o) => o.name === 'channel')!;
    expect(channel).toMatchObject({
      type: ApplicationCommandOptionType.Channel,
      required: false,
      channel_types: [ChannelType.GuildText, ChannelType.GuildAnnouncement],
    });
    expect(opts.find((o) => o.name === 'search')).toMatchObject({ autocomplete: true });
    expect(opts.find((o) => o.name === 'duration')).toMatchObject({
      type: ApplicationCommandOptionType.String,
    });
  });

  it('builds subcommands and subcommand groups', () => {
    const sub = (name: string) => ({ ...leaf, name, node: `voice:${name}` });
    const tree = defineTree({
      name: 'voice',
      description: 'Voice',
      subcommands: [sub('lock')],
      groups: [{ name: 'hub', description: 'Hubs', subcommands: [sub('add')] }],
    });
    const json = commandToJson(tree);
    expect(json.options!.map((o) => [o.name, o.type])).toEqual([
      ['lock', ApplicationCommandOptionType.Subcommand],
      ['hub', ApplicationCommandOptionType.SubcommandGroup],
    ]);
  });

  it('produces a stable hash for the real command set', () => {
    const a = buildRegistrationPayload(allCommands);
    const b = buildRegistrationPayload(allCommands);
    expect(a.hash).toBe(b.hash);
    expect(a.body.length).toBe(allCommands.length);
  });
});

describe('CommandRegistry', () => {
  const base = { description: 'd', options: {}, execute: async () => ok('') };

  it('loads the real command set and lists nodes with wildcards', () => {
    const reg = new CommandRegistry(allCommands);
    const nodes = reg.allNodes().map((n) => n.node);
    expect(nodes).toEqual(
      expect.arrayContaining([
        '*',
        'admin:*',
        'public:*',
        'public:help',
        'config:permset',
        'dashboard:access',
      ]),
    );
    expect(reg.find('permset')?.leaf.node).toBe('config:permset');
  });

  it('validates nodes', () => {
    const reg = new CommandRegistry(allCommands);
    expect(reg.isValidNode('public:help')).toBe(true);
    expect(reg.isValidNode('admin:*')).toBe(true);
    expect(reg.isValidNode('*')).toBe(true);
    expect(reg.isValidNode('dashboard:access')).toBe(true);
    expect(reg.isValidNode('public:nope')).toBe(false);
    expect(reg.isValidNode('bogus:*')).toBe(false);
    expect(reg.isValidNode('Admin:ban')).toBe(false);
  });

  it('rejects duplicates, bad names and bad nodes', () => {
    expect(
      () =>
        new CommandRegistry([
          { ...base, name: 'a', node: 'admin:a' },
          { ...base, name: 'a', node: 'admin:b' },
        ]),
    ).toThrow(/Duplicate/);
    expect(() => new CommandRegistry([{ ...base, name: 'Bad', node: 'admin:a' }])).toThrow(
      /Invalid command name/,
    );
    expect(() => new CommandRegistry([{ ...base, name: 'a', node: 'admin:*' }])).toThrow(/concrete node/);
    expect(() => new CommandRegistry([{ ...base, name: 'a', node: 'weird:a' }])).toThrow(
      /unknown permission category/,
    );
    expect(() => new CommandRegistry([{ name: 'empty', description: 'd' }])).toThrow(/no subcommands/);
  });

  it('rejects options that break Discord limits', () => {
    const tooMany = Object.fromEntries(
      Array.from({ length: 26 }, (_, i) => [`o${i}`, opt.string({ description: 'x' })]),
    );
    expect(() => new CommandRegistry([{ ...base, name: 'a', node: 'admin:a', options: tooMany }])).toThrow(
      /25 options/,
    );
    expect(
      () =>
        new CommandRegistry([
          {
            ...base,
            name: 'a',
            node: 'admin:a',
            options: {
              x: opt.string({ description: 'x', autocomplete: true, choices: [{ name: 'a', value: 'a' }] }),
            },
          },
        ]),
    ).toThrow(/both choices and autocomplete/);
  });
});
