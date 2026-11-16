/**
 * Permission node helpers. Shared between the bot, the API and the dashboard (no Node/Discord imports).
 *
 * Node formats:
 *   "category:command"  e.g. admin:ban       (specificity 3)
 *   "category:*"        e.g. admin:*         (specificity 2)
 *   "*"                 everything           (specificity 1)
 */

export const PERMISSION_CATEGORIES = ['admin', 'config', 'public', 'voice', 'dashboard'] as const;
export type PermissionCategory = (typeof PERMISSION_CATEGORIES)[number];

/** What a node resolves to when no rule matches. public:* and voice:* are open to @everyone. */
export const CATEGORY_DEFAULT_ALLOW: Record<PermissionCategory, boolean> = {
  admin: false,
  config: false,
  public: true,
  voice: true,
  dashboard: false,
};

const SEGMENT = /^[a-z][a-z0-9_-]{0,31}$/;

export type ParsedNode =
  | { kind: 'global' }
  | { kind: 'category'; category: string }
  | { kind: 'exact'; category: string; command: string };

/** Parse a node pattern; returns null when malformed. */
export function parseNode(node: string): ParsedNode | null {
  if (node === '*') return { kind: 'global' };
  const parts = node.split(':');
  if (parts.length !== 2) return null;
  const [category, command] = parts as [string, string];
  if (!SEGMENT.test(category)) return null;
  if (command === '*') return { kind: 'category', category };
  if (!SEGMENT.test(command)) return null;
  return { kind: 'exact', category, command };
}

export function isCategory(value: string): value is PermissionCategory {
  return (PERMISSION_CATEGORIES as readonly string[]).includes(value);
}

export function specificityOf(pattern: string): 0 | 1 | 2 | 3 {
  const p = parseNode(pattern);
  if (!p) return 0;
  return p.kind === 'global' ? 1 : p.kind === 'category' ? 2 : 3;
}

/**
 * Patterns that can match a concrete node, most specific first.
 * candidatePatterns("admin:ban") → ["admin:ban", "admin:*", "*"]
 */
export function candidatePatterns(node: string): string[] {
  const p = parseNode(node);
  if (!p || p.kind !== 'exact') throw new Error(`Not a concrete permission node: ${node}`);
  return [node, `${p.category}:*`, '*'];
}

export function categoryOf(node: string): string | null {
  const p = parseNode(node);
  if (!p || p.kind === 'global') return null;
  return p.category;
}
