import { and, asc, eq } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { permissionRules } from '../../db/schema.js';
import type { AuditActor, AuditService } from '../audit.js';
import type { CommandRegistry } from '../commands/registry.js';
import { UserError } from '../errors.js';
import type { SettingsService } from '../settings.js';
import {
  type PermissionDecision,
  type PermissionRule,
  type PermissionSubject,
  resolvePermission,
} from './resolver.js';

export type PermissionRuleRow = typeof permissionRules.$inferSelect;

/** Stores permission rules and answers "may this member use node X?". */
export class PermissionService {
  constructor(
    private readonly db: Db,
    private readonly guildId: string,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
    private readonly registry: () => CommandRegistry,
  ) {}

  /** The @everyone role ID equals the guild ID in Discord. */
  get everyoneRoleId(): string {
    return this.guildId;
  }

  listRules(roleId?: string): PermissionRuleRow[] {
    const where = roleId
      ? and(eq(permissionRules.guildId, this.guildId), eq(permissionRules.roleId, roleId))
      : eq(permissionRules.guildId, this.guildId);
    return this.db
      .select()
      .from(permissionRules)
      .where(where)
      .orderBy(asc(permissionRules.roleId), asc(permissionRules.node))
      .all();
  }

  hasAnyRules(): boolean {
    return (
      this.db
        .select({ id: permissionRules.id })
        .from(permissionRules)
        .where(eq(permissionRules.guildId, this.guildId))
        .limit(1)
        .get() !== undefined
    );
  }

  check(subject: PermissionSubject, node: string): PermissionDecision {
    const rules: PermissionRule[] = this.listRules().map((r) => ({
      roleId: r.roleId,
      node: r.node,
      allow: r.allow,
    }));
    return resolvePermission(subject, node, rules, {
      everyoneRoleId: this.everyoneRoleId,
      adminBypass: this.settings.get().permissions.adminBypass,
    });
  }

  private assertNode(node: string): void {
    if (!this.registry().isValidNode(node)) {
      throw new UserError(`Unknown permission node \`${node}\`. Use autocomplete to pick a valid node.`);
    }
  }

  setRule(actor: AuditActor, roleId: string, node: string, allow: boolean): { previous: boolean | null } {
    this.assertNode(node);
    const existing = this.find(roleId, node);
    this.db
      .insert(permissionRules)
      .values({ guildId: this.guildId, roleId, node, allow, createdBy: actor.id, createdAt: new Date() })
      .onConflictDoUpdate({
        target: [permissionRules.guildId, permissionRules.roleId, permissionRules.node],
        set: { allow, createdBy: actor.id, createdAt: new Date() },
      })
      .run();
    this.audit.record(actor, {
      action: 'permissions.set',
      target: `${roleId}:${node}`,
      before: existing ? { roleId, node, allow: existing.allow } : null,
      after: { roleId, node, allow },
    });
    return { previous: existing ? existing.allow : null };
  }

  unsetRule(actor: AuditActor, roleId: string, node: string): boolean {
    const existing = this.find(roleId, node);
    if (!existing) return false;
    this.db.delete(permissionRules).where(eq(permissionRules.id, existing.id)).run();
    this.audit.record(actor, {
      action: 'permissions.unset',
      target: `${roleId}:${node}`,
      before: { roleId, node, allow: existing.allow },
      after: null,
    });
    return true;
  }

  private find(roleId: string, node: string): PermissionRuleRow | undefined {
    return this.db
      .select()
      .from(permissionRules)
      .where(
        and(
          eq(permissionRules.guildId, this.guildId),
          eq(permissionRules.roleId, roleId),
          eq(permissionRules.node, node),
        ),
      )
      .get();
  }
}
