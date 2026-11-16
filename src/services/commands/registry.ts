import type { z } from 'zod';
import { buildInputSchema, type OptionDescriptor } from '../../shared/commandOptions.js';
import { categoryOf, isCategory, PERMISSION_CATEGORIES, parseNode } from '../../shared/permissions.js';
import { type CommandDefinition, isLeaf, type LeafCommand } from './types.js';

export interface FlatCommand {
  /** e.g. ["voice", "hub", "add"] */
  path: string[];
  /** e.g. "voice hub add" */
  fullName: string;
  leaf: LeafCommand;
  schema: z.ZodType<Record<string, unknown>>;
}

export interface ExtraNode {
  node: string;
  description: string;
}

const NAME = /^[a-z0-9_-]{1,32}$/;

/** Nodes that aren't commands but are checked by the dashboard. */
export const EXTRA_NODES: ExtraNode[] = [
  { node: 'dashboard:access', description: 'Log in to the web dashboard' },
  {
    node: 'dashboard:logs',
    description: 'View stored logs (including deleted message content) in the dashboard',
  },
  { node: 'dashboard:audit', description: 'View the audit log of config changes and dashboard actions' },
  {
    node: 'config:settings',
    description: 'Dashboard settings without a slash command (moderation DMs, Administrator bypass)',
  },
];

/**
 * Central list of every command and permission node. Validates Discord naming limits up front so
 * a bad definition fails at startup (and in tests) rather than at registration time.
 */
export class CommandRegistry {
  readonly definitions: readonly CommandDefinition[];
  private readonly flat = new Map<string, FlatCommand>();

  constructor(
    definitions: CommandDefinition[],
    private readonly extraNodes: ExtraNode[] = EXTRA_NODES,
  ) {
    this.definitions = definitions;
    if (definitions.length > 100) throw new Error('Discord allows at most 100 guild commands');
    const topNames = new Set<string>();
    for (const def of definitions) {
      assertName(def.name, 'command');
      if (topNames.has(def.name)) throw new Error(`Duplicate command name: ${def.name}`);
      topNames.add(def.name);
      if (isLeaf(def)) {
        this.add([def.name], def);
        continue;
      }
      const subs = def.subcommands ?? [];
      const groups = def.groups ?? [];
      if (subs.length + groups.length === 0) throw new Error(`Command ${def.name} has no subcommands`);
      if (subs.length + groups.length > 25) throw new Error(`Command ${def.name} has more than 25 children`);
      const childNames = new Set<string>();
      for (const sub of subs) {
        assertUnique(childNames, sub.name, def.name);
        this.add([def.name, sub.name], sub);
      }
      for (const group of groups) {
        assertName(group.name, 'group');
        assertUnique(childNames, group.name, def.name);
        if (group.subcommands.length === 0 || group.subcommands.length > 25) {
          throw new Error(`Group ${def.name} ${group.name} must have 1-25 subcommands`);
        }
        const groupNames = new Set<string>();
        for (const sub of group.subcommands) {
          assertUnique(groupNames, sub.name, `${def.name} ${group.name}`);
          this.add([def.name, group.name, sub.name], sub);
        }
      }
    }
    for (const extra of extraNodes) assertNode(extra.node, extra.node);
  }

  private add(path: string[], leaf: LeafCommand): void {
    const fullName = path.join(' ');
    assertName(leaf.name, 'subcommand');
    assertNode(leaf.node, fullName);
    if (leaf.description.length < 1 || leaf.description.length > 100) {
      throw new Error(`Description for /${fullName} must be 1-100 characters`);
    }
    const options = Object.entries(leaf.options);
    if (options.length > 25) throw new Error(`/${fullName} has more than 25 options`);
    for (const [name, d] of options) {
      assertName(name, `option of /${fullName}`);
      assertOption(d, `/${fullName} ${name}`);
    }
    this.flat.set(fullName, {
      path,
      fullName,
      leaf,
      schema: buildInputSchema(leaf.options) as z.ZodType<Record<string, unknown>>,
    });
  }

  all(): FlatCommand[] {
    return [...this.flat.values()];
  }

  find(path: string[] | string): FlatCommand | undefined {
    return this.flat.get(Array.isArray(path) ? path.join(' ') : path);
  }

  /** Every concrete node plus category wildcards and "*", sorted. */
  allNodes(): { node: string; description: string }[] {
    const map = new Map<string, string>();
    for (const c of this.flat.values()) {
      const existing = map.get(c.leaf.node);
      map.set(c.leaf.node, existing ? `${existing}, /${c.fullName}` : `/${c.fullName}`);
    }
    for (const e of this.extraNodes) map.set(e.node, e.description);
    for (const cat of PERMISSION_CATEGORIES) map.set(`${cat}:*`, `Every ${cat} command`);
    map.set('*', 'Everything');
    return [...map.entries()]
      .map(([node, description]) => ({ node, description }))
      .sort((a, b) => a.node.localeCompare(b.node));
  }

  /** True for registered concrete nodes, known category wildcards and "*". */
  isValidNode(node: string): boolean {
    const p = parseNode(node);
    if (!p) return false;
    if (p.kind === 'global') return true;
    if (p.kind === 'category') return isCategory(p.category);
    return this.allNodes().some((n) => n.node === node);
  }
}

function assertName(name: string, what: string): void {
  if (!NAME.test(name)) throw new Error(`Invalid ${what} name "${name}" (lowercase, 1-32 chars)`);
}

function assertUnique(set: Set<string>, name: string, parent: string): void {
  if (set.has(name)) throw new Error(`Duplicate subcommand "${name}" under /${parent}`);
  set.add(name);
}

function assertNode(node: string, where: string): void {
  const p = parseNode(node);
  if (!p || p.kind !== 'exact')
    throw new Error(`/${where} must declare a concrete node like "admin:ban", got "${node}"`);
  const cat = categoryOf(node)!;
  if (!isCategory(cat)) throw new Error(`/${where} uses unknown permission category "${cat}"`);
}

function assertOption(d: OptionDescriptor, where: string): void {
  if (d.description.length < 1 || d.description.length > 100) {
    throw new Error(`Description for ${where} must be 1-100 characters`);
  }
  if ((d.kind === 'string' || d.kind === 'integer') && d.choices && d.choices.length > 25) {
    throw new Error(`${where} has more than 25 choices`);
  }
  if (d.kind === 'string' && d.autocomplete && d.choices?.length) {
    throw new Error(`${where} cannot use both choices and autocomplete`);
  }
}
