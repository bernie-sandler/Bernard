import {
  CATEGORY_DEFAULT_ALLOW,
  candidatePatterns,
  categoryOf,
  isCategory,
} from '../../shared/permissions.js';

export interface PermissionRule {
  roleId: string;
  node: string;
  allow: boolean;
}

export interface PermissionSubject {
  userId: string;
  /** Role IDs the member has. May or may not include the @everyone role; it is always considered. */
  roleIds: readonly string[];
  isOwner: boolean;
  isAdministrator: boolean;
}

export type DecisionReason = 'owner' | 'administrator' | 'rule' | 'default';

export interface PermissionDecision {
  node: string;
  allowed: boolean;
  reason: DecisionReason;
  /** The rule that decided, when reason === 'rule'. */
  rule?: PermissionRule;
  /** Other rules that matched at the deciding level (for /permcheck explanations). */
  considered?: PermissionRule[];
}

export interface ResolveOptions {
  /** The @everyone role ID (equal to the guild ID in Discord). */
  everyoneRoleId: string;
  adminBypass: boolean;
}

/**
 * Resolve a concrete node ("category:command") for a member.
 *
 * 1. The server owner always passes.
 * 2. Administrators pass when adminBypass is on.
 * 3. Walk from most to least specific pattern (cat:cmd → cat:* → *). At the first level with matches:
 *    a. If any of the member's named roles have a rule there, deny wins among them.
 *    b. Otherwise an @everyone rule at that level decides.
 * 4. With no matching rule, fall back to the category default (public/voice allowed, else denied).
 */
export function resolvePermission(
  subject: PermissionSubject,
  node: string,
  rules: readonly PermissionRule[],
  opts: ResolveOptions,
): PermissionDecision {
  if (subject.isOwner) return { node, allowed: true, reason: 'owner' };
  if (opts.adminBypass && subject.isAdministrator) return { node, allowed: true, reason: 'administrator' };

  const namedRoles = new Set(subject.roleIds.filter((id) => id !== opts.everyoneRoleId));

  for (const pattern of candidatePatterns(node)) {
    const atLevel = rules.filter((r) => r.node === pattern);
    if (atLevel.length === 0) continue;

    const roleRules = atLevel.filter((r) => namedRoles.has(r.roleId));
    if (roleRules.length > 0) {
      const deciding = roleRules.find((r) => !r.allow) ?? roleRules[0]!;
      return { node, allowed: deciding.allow, reason: 'rule', rule: deciding, considered: roleRules };
    }

    const everyoneRule = atLevel.find((r) => r.roleId === opts.everyoneRoleId);
    if (everyoneRule) {
      return {
        node,
        allowed: everyoneRule.allow,
        reason: 'rule',
        rule: everyoneRule,
        considered: [everyoneRule],
      };
    }
  }

  const category = categoryOf(node);
  const allowed = category !== null && isCategory(category) ? CATEGORY_DEFAULT_ALLOW[category] : false;
  return { node, allowed, reason: 'default' };
}

/** Human-readable explanation used by /permcheck and the dashboard. */
export function describeDecision(d: PermissionDecision, roleName: (roleId: string) => string): string {
  const verdict = d.allowed ? 'allowed' : 'denied';
  switch (d.reason) {
    case 'owner':
      return `Allowed: server owner (always passes).`;
    case 'administrator':
      return `Allowed: has Discord's Administrator permission (admin bypass is on).`;
    case 'default': {
      const category = categoryOf(d.node);
      return `${verdict === 'allowed' ? 'Allowed' : 'Denied'}: no rule matched, so the default for \`${category}:*\` applies.`;
    }
    case 'rule': {
      const r = d.rule!;
      const others = (d.considered ?? []).filter((c) => c !== r);
      const tie =
        others.length > 0 && !r.allow
          ? ` (deny wins over ${others.length} allow rule(s) at the same level)`
          : '';
      return `${verdict === 'allowed' ? 'Allowed' : 'Denied'} by rule \`${r.node}\` = ${r.allow} on ${roleName(r.roleId)}${tie}.`;
    }
  }
}
