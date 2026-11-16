import type { AutocompleteHandler } from '../../services/commands/types.js';
import { defineCommand } from '../../services/commands/types.js';
import { UserError } from '../../services/errors.js';
import { describeDecision } from '../../services/permissions/resolver.js';
import { opt } from '../../shared/commandOptions.js';
import { COLORS, ok } from '../../shared/commandResult.js';

export const nodeAutocomplete: AutocompleteHandler = (ctx, focused) => {
  const q = focused.toLowerCase();
  return ctx.services.registry
    .allNodes()
    .filter((n) => n.node.includes(q) || n.description.toLowerCase().includes(q))
    .slice(0, 25)
    .map((n) => ({ name: `${n.node} (${n.description})`.slice(0, 100), value: n.node }));
};

const nodeOpt = opt.string({
  description: 'Permission node, e.g. admin:ban or admin:*',
  required: true,
  autocomplete: true,
  maxLength: 70,
});

export const permset = defineCommand({
  name: 'permset',
  description: 'Allow or deny a permission node for a role',
  node: 'config:permset',
  options: {
    node: nodeOpt,
    role: opt.role({ description: 'Role to set the rule on (@everyone works too)', required: true }),
    value: opt.boolean({ description: 'true = allow, false = deny', required: true }),
  },
  autocomplete: { node: nodeAutocomplete },
  async execute(ctx, input) {
    const { permissions, guild } = ctx.services;
    const { previous } = permissions.setRule(
      { id: ctx.actor.userId, source: ctx.source },
      input.role,
      input.node,
      input.value,
    );
    const verb = input.value ? 'allowed' : 'denied';
    const change = previous === null ? '' : previous === input.value ? ' (unchanged)' : ` (was ${previous})`;
    return ok(`\`${input.node}\` is now **${verb}** for ${guild.roleName(input.role)}${change}.`);
  },
});

export const permunset = defineCommand({
  name: 'permunset',
  description: 'Remove a permission rule from a role entirely',
  node: 'config:permunset',
  options: {
    node: nodeOpt,
    role: opt.role({ description: 'Role to remove the rule from', required: true }),
  },
  autocomplete: { node: nodeAutocomplete },
  async execute(ctx, input) {
    const removed = ctx.services.permissions.unsetRule(
      { id: ctx.actor.userId, source: ctx.source },
      input.role,
      input.node,
    );
    if (!removed)
      throw new UserError(`${ctx.services.guild.roleName(input.role)} has no rule for \`${input.node}\`.`);
    return ok(`Removed the \`${input.node}\` rule from ${ctx.services.guild.roleName(input.role)}.`);
  },
});

export const permlist = defineCommand({
  name: 'permlist',
  description: 'List permission rules, optionally for one role',
  node: 'config:permlist',
  options: {
    role: opt.role({ description: 'Only show rules for this role' }),
  },
  async execute(ctx, input) {
    const { permissions, guild } = ctx.services;
    const rules = permissions.listRules(input.role);
    if (rules.length === 0) {
      return ok(
        input.role
          ? `${guild.roleName(input.role)} has no rules. Defaults apply: \`public:*\` and \`voice:*\` allowed, everything else denied.`
          : 'No rules set. Defaults apply: `public:*` and `voice:*` allowed, everything else denied. The owner (and Administrators, if admin bypass is on) can use everything.',
      );
    }
    const byRole = new Map<string, string[]>();
    for (const r of rules) {
      const lines = byRole.get(r.roleId) ?? [];
      lines.push(`${r.allow ? '✅' : '⛔'} \`${r.node}\``);
      byRole.set(r.roleId, lines);
    }
    const fields = [...byRole.entries()].slice(0, 25).map(([roleId, lines]) => {
      let value = lines.join('\n');
      if (value.length > 1024) value = `${value.slice(0, 1000)}\n…`;
      return { name: guild.roleName(roleId).slice(0, 256), value };
    });
    return ok('', {
      embeds: [
        {
          title: 'Permission rules',
          color: COLORS.info,
          fields,
          footer: `${rules.length} rule(s) • most specific wins • deny wins between roles • roles beat @everyone`,
        },
      ],
    });
  },
});

export const permcheck = defineCommand({
  name: 'permcheck',
  description: 'Check whether a member may use a node, and which rule decided',
  node: 'config:permcheck',
  options: {
    user: opt.user({ description: 'Member to check', required: true }),
    node: opt.string({
      description: 'Concrete node, e.g. admin:ban',
      required: true,
      autocomplete: true,
      maxLength: 70,
    }),
  },
  autocomplete: {
    node: async (ctx, focused) =>
      (await nodeAutocomplete(ctx, focused)).filter((c) => c.value !== '*' && !c.value.endsWith(':*')),
  },
  async execute(ctx, input) {
    const { permissions, guild, registry } = ctx.services;
    if (input.node === '*' || input.node.endsWith(':*') || !registry.isValidNode(input.node)) {
      throw new UserError(`Pick a concrete, registered node like \`admin:ban\` (got \`${input.node}\`).`);
    }
    const member = await guild.getMember(input.user);
    if (!member) throw new UserError('That user is not a member of this server.');
    const decision = permissions.check(member, input.node);
    return ok('', {
      embeds: [
        {
          title: `${decision.allowed ? '✅ Allowed' : '⛔ Denied'}: ${input.node}`,
          color: decision.allowed ? COLORS.success : COLORS.danger,
          description: `<@${member.userId}>\n${describeDecision(decision, (id) => guild.roleName(id))}`,
        },
      ],
    });
  },
});

export const permissionCommands = [permset, permunset, permlist, permcheck];
