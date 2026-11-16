import { desc, eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { allCommands } from '../src/bot/commands/index.js';
import { auditLog, logs } from '../src/db/schema.js';
import { defineCommand } from '../src/services/commands/types.js';
import { UserError } from '../src/services/errors.js';
import { opt } from '../src/shared/commandOptions.js';
import { ok } from '../src/shared/commandResult.js';
import { GUILD_ID, makeActor, OWNER_ID, testContainer } from './helpers.js';

const LOG_CHANNEL = '900000000000000001';

const echo = defineCommand({
  name: 'echo',
  description: 'Echo',
  node: 'admin:echo',
  options: { text: opt.string({ description: 't', required: true, maxLength: 20 }) },
  execute: async (_ctx, input) => ok(`echo ${input.text}`),
});
const boom = defineCommand({
  name: 'boom',
  description: 'Throws',
  node: 'public:boom',
  options: { kind: opt.string({ description: 'k', required: true }) },
  execute: async (_ctx, input) => {
    if (input.kind === 'user') throw new UserError('Friendly failure');
    if (input.kind === 'discord') throw Object.assign(new Error('x'), { code: 50013, status: 403 });
    throw new Error('internal detail');
  },
});
const discordOnly = defineCommand({
  name: 'donly',
  description: 'Discord only',
  node: 'public:donly',
  dashboard: false,
  options: {},
  execute: async () => ok('hi'),
});

let t: ReturnType<typeof testContainer>;
afterEach(() => t?.close());

function setup() {
  t = testContainer([...allCommands, echo, boom, discordOnly]);
  t.services.settings.update({ id: OWNER_ID, source: 'system' }, 'test', (s) => {
    s.logs.channels.commands = LOG_CHANNEL;
  });
  return t;
}

const run = (
  name: string,
  member: ReturnType<typeof t.guild.addMember>,
  rawInput: Record<string, unknown> = {},
  source: 'slash' | 'dashboard' = 'slash',
) =>
  t.executor.run({
    command: t.services.registry.find(name)!,
    actor: makeActor(member),
    source,
    rawInput,
    channelId: source === 'slash' ? '800000000000000001' : undefined,
  });

function lastLog() {
  return t.db.select().from(logs).orderBy(desc(logs.id)).get()!;
}

describe('CommandExecutor', () => {
  it('denies without a matching rule, replies ephemerally with the node and logs the denial', async () => {
    setup();
    const member = t.guild.addMember();
    let allowedCalled = false;
    const res = await t.executor.run({
      command: t.services.registry.find('echo')!,
      actor: makeActor(member),
      source: 'slash',
      rawInput: { text: 'hi' },
      onAllowed: () => {
        allowedCalled = true;
      },
    });
    expect(res.outcome).toBe('denied');
    expect(res.result).toMatchObject({
      ok: false,
      ephemeral: true,
      content: "You don't have permission (`admin:echo`).",
    });
    expect(allowedCalled).toBe(false);
    const row = lastLog();
    expect(row).toMatchObject({ type: 'commands', event: 'command_denied', actorId: member.userId });
    expect(row.data).toMatchObject({ allowed: false, source: 'slash', command: 'echo' });
    expect(t.messenger.sent.at(-1)).toMatchObject({
      channelId: LOG_CHANNEL,
      embed: { title: 'Command denied' },
    });
  });

  it('runs once a rule allows it and logs success with args', async () => {
    setup();
    const mod = t.guild.addRole('Mod');
    t.services.permissions.setRule({ id: OWNER_ID, source: 'system' }, mod, 'admin:*', true);
    const member = t.guild.addMember({ roleIds: [mod] });
    const res = await run('echo', member, { text: 'hello' });
    expect(res).toMatchObject({ outcome: 'ok', result: { ok: true, content: 'echo hello' } });
    expect(lastLog()).toMatchObject({
      event: 'command_used',
      summary: expect.stringContaining('/echo text:hello'),
    });
  });

  it('checks permission before validating input', async () => {
    setup();
    const res = await run('echo', t.guild.addMember(), { text: 123 });
    expect(res.outcome).toBe('denied');
  });

  it('reports validation errors as invalid', async () => {
    setup();
    const owner = t.guild.addMember({ userId: OWNER_ID });
    const res = await run('echo', owner, { text: 'x'.repeat(30) });
    expect(res.outcome).toBe('invalid');
    expect(res.result.content).toMatch(/Invalid input/);
  });

  it('maps UserError, Discord API errors and unexpected errors to friendly messages', async () => {
    setup();
    const m = t.guild.addMember();
    expect((await run('boom', m, { kind: 'user' })).result.content).toBe('Friendly failure');
    expect((await run('boom', m, { kind: 'discord' })).result.content).toMatch(
      /missing a Discord permission/,
    );
    const internal = await run('boom', m, { kind: 'other' });
    expect(internal.outcome).toBe('error');
    expect(internal.result.content).not.toMatch(/internal detail/);
  });

  it('records the dashboard as the source and blocks Discord-only commands there', async () => {
    setup();
    const owner = t.guild.addMember({ userId: OWNER_ID });
    await run('ping', owner, {}, 'dashboard');
    expect(lastLog().data).toMatchObject({ source: 'dashboard', allowed: true });
    expect((await run('donly', owner, {}, 'dashboard')).outcome).toBe('invalid');
  });

  it('still answers when posting to the log channel fails', async () => {
    setup();
    t.messenger.fail = true;
    const res = await run('ping', t.guild.addMember());
    expect(res.result.ok).toBe(true);
  });
});

describe('permission commands', () => {
  it('/permset validates nodes, stores the rule and audits it', async () => {
    setup();
    const owner = t.guild.addMember({ userId: OWNER_ID });
    const mod = t.guild.addRole('Mod');

    const bad = await run('permset', owner, { node: 'admin:nope', role: mod, value: true });
    expect(bad.result).toMatchObject({
      ok: false,
      content: expect.stringMatching(/Unknown permission node/),
    });

    const good = await run('permset', owner, { node: 'admin:*', role: mod, value: true });
    expect(good.result.content).toMatch(/`admin:\*` is now \*\*allowed\*\* for @Mod/);
    expect(t.services.permissions.listRules(mod)).toMatchObject([{ node: 'admin:*', allow: true }]);

    const again = await run('permset', owner, { node: 'admin:*', role: mod, value: false });
    expect(again.result.content).toMatch(/denied.*\(was true\)/);

    const audits = t.db.select().from(auditLog).where(eq(auditLog.action, 'permissions.set')).all();
    expect(audits).toHaveLength(2);
    expect(audits[1]).toMatchObject({ source: 'slash', before: { allow: true }, after: { allow: false } });
  });

  it('/permunset removes a rule and errors if none exists', async () => {
    setup();
    const owner = t.guild.addMember({ userId: OWNER_ID });
    const mod = t.guild.addRole('Mod');
    expect((await run('permunset', owner, { node: 'admin:*', role: mod })).result.ok).toBe(false);
    await run('permset', owner, { node: 'admin:*', role: mod, value: false });
    expect((await run('permunset', owner, { node: 'admin:*', role: mod })).result.ok).toBe(true);
    expect(t.services.permissions.listRules()).toHaveLength(0);
  });

  it('/permcheck explains which rule decided', async () => {
    setup();
    const owner = t.guild.addMember({ userId: OWNER_ID });
    const mod = t.guild.addRole('Mod');
    const helper = t.guild.addRole('Helper');
    const target = t.guild.addMember({ roleIds: [mod, helper] });
    await run('permset', owner, { node: 'config:permlist', role: mod, value: true });
    await run('permset', owner, { node: 'config:permlist', role: helper, value: false });
    const res = await run('permcheck', owner, { user: target.userId, node: 'config:permlist' });
    const embed = res.result.embeds![0]!;
    expect(embed.title).toMatch(/Denied/);
    expect(embed.description).toMatch(/@Helper \(deny wins/);
  });

  it('/permcheck rejects wildcards', async () => {
    setup();
    const owner = t.guild.addMember({ userId: OWNER_ID });
    const res = await run('permcheck', owner, { user: owner.userId, node: 'admin:*' });
    expect(res.result.ok).toBe(false);
  });

  it('/permlist shows rules grouped by role, including @everyone', async () => {
    setup();
    const owner = t.guild.addMember({ userId: OWNER_ID });
    await run('permset', owner, { node: 'public:*', role: GUILD_ID, value: false });
    const res = await run('permlist', owner);
    expect(res.result.embeds![0]!.fields).toEqual([{ name: '@everyone', value: '⛔ `public:*`' }]);
  });

  it('/help lists only commands the member may use', async () => {
    setup();
    const member = t.guild.addMember();
    const res = await run('help', member);
    const text = JSON.stringify(res.result.embeds);
    expect(text).toContain('/ping');
    expect(text).not.toContain('/permset');
    const owner = t.guild.addMember({ userId: OWNER_ID });
    expect(JSON.stringify((await run('help', owner)).result.embeds)).toContain('/permset');
  });

  it('node autocomplete filters the registry', async () => {
    setup();
    const owner = t.guild.addMember({ userId: OWNER_ID });
    const ac = t.services.registry.find('permset')!.leaf.autocomplete!.node!;
    const choices = await ac({ guildId: GUILD_ID, actor: makeActor(owner), services: t.services }, 'perm');
    expect(choices.map((c) => c.value)).toEqual(
      expect.arrayContaining(['config:permset', 'config:permunset', 'config:permlist', 'config:permcheck']),
    );
    expect(choices.length).toBeLessThanOrEqual(25);
  });
});
