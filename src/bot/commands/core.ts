import { defineCommand } from '../../services/commands/types.js';
import { COLORS, ok } from '../../shared/commandResult.js';
import { PERMISSION_CATEGORIES } from '../../shared/permissions.js';

const CATEGORY_TITLES: Record<string, string> = {
  public: 'General',
  voice: 'Voice channels',
  admin: 'Moderation',
  config: 'Configuration',
  dashboard: 'Dashboard',
};

export const help = defineCommand({
  name: 'help',
  description: 'List the commands you can use',
  node: 'public:help',
  options: {},
  async execute(ctx) {
    const { registry, permissions } = ctx.services;
    const allowed = registry.all().filter((c) => permissions.check(ctx.actor, c.leaf.node).allowed);
    const byCategory = new Map<string, string[]>();
    for (const c of allowed) {
      const category = c.leaf.node.split(':')[0]!;
      const lines = byCategory.get(category) ?? [];
      lines.push(`\`/${c.fullName}\`: ${c.leaf.description}`);
      byCategory.set(category, lines);
    }
    const fields = PERMISSION_CATEGORIES.filter((cat) => byCategory.has(cat)).flatMap((cat) => {
      // Split long categories across fields (1024 char limit per field).
      const chunks: string[] = [];
      let current = '';
      for (const line of byCategory.get(cat)!) {
        if (current.length + line.length + 1 > 1024) {
          chunks.push(current);
          current = '';
        }
        current += `${current ? '\n' : ''}${line}`;
      }
      if (current) chunks.push(current);
      return chunks.map((value, i) => ({ name: i === 0 ? (CATEGORY_TITLES[cat] ?? cat) : '​', value }));
    });
    return ok('', {
      embeds: [
        {
          title: 'Commands you can use',
          color: COLORS.info,
          fields: fields.slice(0, 25),
          footer: `${allowed.length} command(s)`,
        },
      ],
    });
  },
});

export const ping = defineCommand({
  name: 'ping',
  description: 'Check that the bot is alive and see its latency',
  node: 'public:ping',
  options: {},
  async execute(ctx) {
    const { bot } = ctx.services;
    const uptimeMin = Math.floor(bot.uptimeMs() / 60_000);
    const ws = bot.wsPingMs();
    return ok(`Pong! Gateway latency: ${ws >= 0 ? `${ws} ms` : 'measuring…'} • Uptime: ${uptimeMin} min`);
  },
});

export const coreCommands = [help, ping];
