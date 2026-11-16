import { describe, expect, it } from 'vitest';
import {
  describeDecision,
  type PermissionRule,
  type PermissionSubject,
  resolvePermission,
} from '../src/services/permissions/resolver.js';
import { candidatePatterns, parseNode, specificityOf } from '../src/shared/permissions.js';

const EVERYONE = 'everyone';
const MOD = 'mod';
const ADMIN = 'admin';
const HELPER = 'helper';

const opts = { everyoneRoleId: EVERYONE, adminBypass: true };

function subject(roles: string[], extra: Partial<PermissionSubject> = {}): PermissionSubject {
  return { userId: 'u1', roleIds: [EVERYONE, ...roles], isOwner: false, isAdministrator: false, ...extra };
}
const rule = (roleId: string, node: string, allow: boolean): PermissionRule => ({ roleId, node, allow });

describe('node parsing', () => {
  it('parses exact, category and global nodes', () => {
    expect(parseNode('admin:ban')).toEqual({ kind: 'exact', category: 'admin', command: 'ban' });
    expect(parseNode('admin:*')).toEqual({ kind: 'category', category: 'admin' });
    expect(parseNode('*')).toEqual({ kind: 'global' });
  });

  it.each(['', 'admin', 'admin:', ':ban', 'Admin:ban', 'admin:ban:x', 'admin: ban', '**', 'a:*:*'])(
    'rejects malformed node %j',
    (n) => {
      expect(parseNode(n)).toBeNull();
    },
  );

  it('orders candidate patterns from most to least specific', () => {
    expect(candidatePatterns('admin:ban')).toEqual(['admin:ban', 'admin:*', '*']);
    expect(specificityOf('admin:ban')).toBe(3);
    expect(specificityOf('admin:*')).toBe(2);
    expect(specificityOf('*')).toBe(1);
  });

  it('refuses to resolve a wildcard as a concrete node', () => {
    expect(() => candidatePatterns('admin:*')).toThrow();
  });
});

describe('resolvePermission', () => {
  describe('bypasses', () => {
    it('server owner always passes, even with explicit denies', () => {
      const rules = [rule(EVERYONE, '*', false), rule(MOD, 'admin:ban', false)];
      const d = resolvePermission(subject([MOD], { isOwner: true }), 'admin:ban', rules, opts);
      expect(d).toMatchObject({ allowed: true, reason: 'owner' });
    });

    it('owner passes even when admin bypass is off', () => {
      const d = resolvePermission(subject([], { isOwner: true }), 'admin:ban', [], {
        ...opts,
        adminBypass: false,
      });
      expect(d.allowed).toBe(true);
    });

    it('administrators pass when adminBypass is on, regardless of rules', () => {
      const rules = [rule(ADMIN, 'admin:ban', false)];
      const d = resolvePermission(subject([ADMIN], { isAdministrator: true }), 'admin:ban', rules, opts);
      expect(d).toMatchObject({ allowed: true, reason: 'administrator' });
    });

    it('administrators go through normal rules when adminBypass is off', () => {
      const off = { ...opts, adminBypass: false };
      const s = subject([ADMIN], { isAdministrator: true });
      expect(resolvePermission(s, 'admin:ban', [], off)).toMatchObject({ allowed: false, reason: 'default' });
      expect(resolvePermission(s, 'admin:ban', [rule(ADMIN, 'admin:ban', true)], off)).toMatchObject({
        allowed: true,
        reason: 'rule',
      });
    });
  });

  describe('category defaults', () => {
    it.each([
      ['public:rank', true],
      ['voice:lock', true],
      ['admin:ban', false],
      ['config:tiers', false],
      ['dashboard:access', false],
    ])('%s defaults to %s with no rules', (node, expected) => {
      const d = resolvePermission(subject([]), node, [], opts);
      expect(d).toMatchObject({ allowed: expected, reason: 'default' });
    });

    it('unknown categories default to denied', () => {
      expect(resolvePermission(subject([]), 'mystery:thing', [], opts).allowed).toBe(false);
    });

    it('a deny can close a default-open category', () => {
      const d = resolvePermission(subject([]), 'public:rank', [rule(EVERYONE, 'public:*', false)], opts);
      expect(d).toMatchObject({ allowed: false, reason: 'rule' });
    });
  });

  describe('specificity', () => {
    it('exact beats category wildcard', () => {
      const rules = [rule(MOD, 'admin:*', true), rule(MOD, 'admin:ban', false)];
      expect(resolvePermission(subject([MOD]), 'admin:ban', rules, opts).allowed).toBe(false);
      expect(resolvePermission(subject([MOD]), 'admin:kick', rules, opts).allowed).toBe(true);
    });

    it('category wildcard beats global wildcard', () => {
      const rules = [rule(MOD, '*', true), rule(MOD, 'admin:*', false)];
      expect(resolvePermission(subject([MOD]), 'admin:ban', rules, opts).allowed).toBe(false);
      expect(resolvePermission(subject([MOD]), 'config:tiers', rules, opts).allowed).toBe(true);
    });

    it('a more specific allow on one role beats a less specific deny on another role', () => {
      const rules = [rule(HELPER, 'admin:*', false), rule(MOD, 'admin:warn', true)];
      const d = resolvePermission(subject([MOD, HELPER]), 'admin:warn', rules, opts);
      expect(d).toMatchObject({ allowed: true, rule: { roleId: MOD, node: 'admin:warn' } });
    });

    it('global wildcard grants everything when nothing more specific matches', () => {
      const d = resolvePermission(subject([ADMIN]), 'config:tiers', [rule(ADMIN, '*', true)], opts);
      expect(d).toMatchObject({ allowed: true, rule: { node: '*' } });
    });

    it('rules for roles the member lacks are ignored', () => {
      const d = resolvePermission(subject([HELPER]), 'admin:ban', [rule(MOD, 'admin:ban', true)], opts);
      expect(d).toMatchObject({ allowed: false, reason: 'default' });
    });
  });

  describe('deny wins at equal specificity', () => {
    it('between two named roles at the exact level', () => {
      const rules = [rule(MOD, 'admin:ban', true), rule(HELPER, 'admin:ban', false)];
      const d = resolvePermission(subject([MOD, HELPER]), 'admin:ban', rules, opts);
      expect(d).toMatchObject({ allowed: false, rule: { roleId: HELPER } });
      expect(d.considered).toHaveLength(2);
    });

    it('between two named roles at the wildcard level', () => {
      const rules = [rule(MOD, 'admin:*', false), rule(HELPER, 'admin:*', true)];
      expect(resolvePermission(subject([MOD, HELPER]), 'admin:kick', rules, opts).allowed).toBe(false);
    });

    it('regardless of rule order', () => {
      const a = [rule(HELPER, 'admin:ban', false), rule(MOD, 'admin:ban', true)];
      const b = [...a].reverse();
      expect(resolvePermission(subject([MOD, HELPER]), 'admin:ban', a, opts).allowed).toBe(false);
      expect(resolvePermission(subject([MOD, HELPER]), 'admin:ban', b, opts).allowed).toBe(false);
    });
  });

  describe('@everyone is the baseline', () => {
    it('a named role allow beats an @everyone deny at the same level', () => {
      const rules = [rule(EVERYONE, 'admin:*', false), rule(MOD, 'admin:*', true)];
      const d = resolvePermission(subject([MOD]), 'admin:ban', rules, opts);
      expect(d).toMatchObject({ allowed: true, rule: { roleId: MOD } });
    });

    it('a named role deny beats an @everyone allow at the same level', () => {
      const rules = [rule(EVERYONE, 'public:rank', true), rule(MOD, 'public:rank', false)];
      expect(resolvePermission(subject([MOD]), 'public:rank', rules, opts).allowed).toBe(false);
    });

    it('@everyone decides when no named role matches at that level', () => {
      const rules = [rule(EVERYONE, 'admin:warn', true)];
      expect(resolvePermission(subject([HELPER]), 'admin:warn', rules, opts)).toMatchObject({
        allowed: true,
        rule: { roleId: EVERYONE },
      });
    });

    it('a more specific @everyone rule still beats a less specific named role rule', () => {
      const rules = [rule(MOD, 'admin:*', true), rule(EVERYONE, 'admin:ban', false)];
      expect(resolvePermission(subject([MOD]), 'admin:ban', rules, opts).allowed).toBe(false);
    });

    it('works when the subject role list omits @everyone', () => {
      const s: PermissionSubject = { userId: 'u', roleIds: [], isOwner: false, isAdministrator: false };
      expect(resolvePermission(s, 'admin:warn', [rule(EVERYONE, 'admin:warn', true)], opts).allowed).toBe(
        true,
      );
    });
  });

  describe('describeDecision', () => {
    const name = (id: string) => (id === EVERYONE ? '@everyone' : `@${id}`);
    it('explains owner, admin, default and rule decisions', () => {
      expect(
        describeDecision(resolvePermission(subject([], { isOwner: true }), 'admin:ban', [], opts), name),
      ).toMatch(/owner/);
      expect(
        describeDecision(
          resolvePermission(subject([], { isAdministrator: true }), 'admin:ban', [], opts),
          name,
        ),
      ).toMatch(/Administrator/);
      expect(describeDecision(resolvePermission(subject([]), 'admin:ban', [], opts), name)).toMatch(
        /default for `admin:\*`/,
      );
      const rules = [rule(MOD, 'admin:ban', true), rule(HELPER, 'admin:ban', false)];
      expect(
        describeDecision(resolvePermission(subject([MOD, HELPER]), 'admin:ban', rules, opts), name),
      ).toMatch(/Denied by rule `admin:ban` = false on @helper \(deny wins over 1 allow/);
    });
  });
});
