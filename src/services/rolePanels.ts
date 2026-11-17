import { and, asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import { type RolePanelOption, rolePanels } from '../db/schema.js';
import type { GuildPort, MessengerPort, ModerationPort } from '../discord/ports.js';
import type { Logger } from '../logger.js';
import { COLORS } from '../shared/commandResult.js';
import type { OutgoingMessage } from '../shared/messages.js';
import type { AuditActor, AuditService } from './audit.js';
import { UserError } from './errors.js';

export type RolePanel = typeof rolePanels.$inferSelect;
export type { RolePanelOption };

export const MAX_PANEL_OPTIONS = 25;
export const MAX_PANELS = 50;

/** Optional text: empty strings become null. */
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((v) => v || null);

export const panelInputSchema = z.object({
  title: z.string().trim().min(1).max(100),
  description: z.string().trim().max(1000).default(''),
  style: z.enum(['buttons', 'select']).default('buttons'),
  mode: z.enum(['multi', 'single']).default('multi'),
  options: z
    .array(
      z.object({
        roleId: z.string().regex(/^\d{17,20}$/, 'must be a Discord ID'),
        label: z.string().trim().min(1).max(80),
        /** Unicode emoji or a custom one like <:name:123>. */
        emoji: optionalText(64).refine(
          (v) => v === null || !/^[\w\s]+$/.test(v),
          'must be an emoji, not text',
        ),
        description: optionalText(100),
      }),
    )
    .min(1, 'add at least one role')
    .max(MAX_PANEL_OPTIONS, `at most ${MAX_PANEL_OPTIONS} roles`)
    .refine((opts) => new Set(opts.map((o) => o.roleId)).size === opts.length, 'each role can appear once'),
});
export type PanelInput = z.input<typeof panelInputSchema>;

/** Component custom IDs: rp:b:<panelId>:<roleId> for buttons, rp:s:<panelId> for the menu. */
export type PanelInteraction =
  | { kind: 'button'; panelId: number; roleId: string }
  | { kind: 'select'; panelId: number };

export function parsePanelCustomId(customId: string): PanelInteraction | null {
  const b = /^rp:b:(\d{1,10}):(\d{17,20})$/.exec(customId);
  if (b) return { kind: 'button', panelId: Number(b[1]), roleId: b[2]! };
  const s = /^rp:s:(\d{1,10})$/.exec(customId);
  if (s) return { kind: 'select', panelId: Number(s[1]) };
  return null;
}

export interface RolePanelDeps {
  db: Db;
  guildId: string;
  guild: GuildPort;
  mod: ModerationPort;
  messenger: MessengerPort;
  audit: AuditService;
  logger: Logger;
}

const mention = (roleId: string) => `<@&${roleId}>`;
const list = (ids: string[]) => ids.map(mention).join(', ');

/** Self-assign role panels: a posted message with buttons or a menu that members use to pick roles. */
export class RolePanelService {
  constructor(private readonly d: RolePanelDeps) {}

  list(): RolePanel[] {
    return this.d.db
      .select()
      .from(rolePanels)
      .where(eq(rolePanels.guildId, this.d.guildId))
      .orderBy(asc(rolePanels.id))
      .all();
  }

  get(id: number): RolePanel | null {
    return (
      this.d.db
        .select()
        .from(rolePanels)
        .where(and(eq(rolePanels.guildId, this.d.guildId), eq(rolePanels.id, id)))
        .get() ?? null
    );
  }

  /** By ID (autocomplete value) or case-insensitive title. */
  find(ref: string): RolePanel | null {
    if (/^\d{1,10}$/.test(ref)) {
      const p = this.get(Number(ref));
      if (p) return p;
    }
    const q = ref.trim().toLowerCase();
    return this.list().find((p) => p.title.toLowerCase() === q) ?? null;
  }

  /** Why a role can't be offered on a panel, or null when it can. Checked on save and on every click. */
  roleProblem(roleId: string): string | null {
    if (roleId === this.d.guildId) return '@everyone is not a real role';
    const role = this.d.guild.getRole(roleId);
    if (!role) return 'the role no longer exists';
    if (role.managed) return 'it is managed by an integration or bot';
    if (role.elevated) return 'it grants moderator or admin permissions';
    if (role.position >= this.d.guild.botMember().highestRolePosition) {
      return "it is not below Bernard's highest role";
    }
    return null;
  }

  private validate(input: PanelInput) {
    const result = panelInputSchema.safeParse(input);
    if (!result.success) {
      throw new UserError(
        result.error.issues.map((i) => `${i.path.join('.') || 'panel'}: ${i.message}`).join('; '),
      );
    }
    for (const o of result.data.options) {
      const problem = this.roleProblem(o.roleId);
      if (problem) throw new UserError(`${this.d.guild.roleName(o.roleId)} can't be offered: ${problem}.`);
    }
    return result.data;
  }

  private require(id: number): RolePanel {
    const p = this.get(id);
    if (!p) throw new UserError('That role panel no longer exists.');
    return p;
  }

  create(actor: AuditActor, input: PanelInput): RolePanel {
    if (this.list().length >= MAX_PANELS) throw new UserError(`You can have at most ${MAX_PANELS} panels.`);
    const data = this.validate(input);
    const row = this.d.db
      .insert(rolePanels)
      .values({ guildId: this.d.guildId, ...data })
      .returning()
      .get();
    this.d.audit.record(actor, { action: 'rolePanels.create', target: String(row.id), after: data });
    return row;
  }

  /** Save changes and update the posted message, if any. */
  async update(actor: AuditActor, id: number, input: PanelInput): Promise<RolePanel> {
    const before = this.require(id);
    const data = this.validate(input);
    this.d.db.update(rolePanels).set(data).where(eq(rolePanels.id, id)).run();
    this.d.audit.record(actor, {
      action: 'rolePanels.edit',
      target: String(id),
      before: {
        title: before.title,
        description: before.description,
        style: before.style,
        mode: before.mode,
        options: before.options,
      },
      after: data,
    });
    return this.refresh(id);
  }

  async remove(actor: AuditActor, id: number): Promise<void> {
    const panel = this.require(id);
    if (panel.channelId && panel.messageId) {
      await this.d.messenger.delete(panel.channelId, panel.messageId).catch((err) => {
        this.d.logger.warn({ err, panelId: id }, 'Could not delete role panel message');
      });
    }
    this.d.db.delete(rolePanels).where(eq(rolePanels.id, id)).run();
    this.d.audit.record(actor, { action: 'rolePanels.delete', target: String(id), before: panel });
  }

  /** Post the panel in a channel. A panel posted elsewhere before is moved (the old message is deleted). */
  async post(actor: AuditActor, id: number, channelId: string): Promise<RolePanel> {
    const panel = this.require(id);
    const c = this.d.guild.getChannel(channelId);
    if (!c || (c.kind !== 'text' && c.kind !== 'announcement')) {
      throw new UserError('Pick a text or announcement channel for the panel.');
    }
    const messageId = await this.d.messenger.send(channelId, this.render(panel));
    if (!messageId) {
      throw new UserError(
        `I can't post in <#${channelId}>. Give me View Channel, Send Messages and Embed Links there.`,
      );
    }
    if (panel.channelId && panel.messageId) {
      await this.d.messenger.delete(panel.channelId, panel.messageId).catch(() => {});
    }
    this.d.db.update(rolePanels).set({ channelId, messageId }).where(eq(rolePanels.id, id)).run();
    this.d.audit.record(actor, {
      action: 'rolePanels.post',
      target: String(id),
      before: { channelId: panel.channelId },
      after: { channelId },
    });
    return this.require(id);
  }

  /** Re-render the posted message. If it was deleted in Discord, forget it. */
  async refresh(id: number): Promise<RolePanel> {
    const panel = this.require(id);
    if (!panel.channelId || !panel.messageId) return panel;
    const ok = await this.d.messenger.edit(panel.channelId, panel.messageId, this.render(panel));
    if (!ok) {
      this.d.db
        .update(rolePanels)
        .set({ channelId: null, messageId: null })
        .where(eq(rolePanels.id, id))
        .run();
      throw new UserError('The posted panel message was deleted. Post it again.');
    }
    return panel;
  }

  render(panel: RolePanel): OutgoingMessage {
    const lines: string[] = [];
    if (panel.description) lines.push(panel.description);
    const described = panel.options.filter((o) => o.description);
    if (described.length > 0) {
      if (lines.length) lines.push('');
      for (const o of panel.options) {
        lines.push(
          `${o.emoji ? `${o.emoji} ` : ''}${mention(o.roleId)}${o.description ? `: ${o.description}` : ''}`,
        );
      }
    }
    const embed = {
      title: panel.title,
      ...(lines.length ? { description: lines.join('\n').slice(0, 4096) } : {}),
      color: COLORS.info,
      footer:
        panel.mode === 'single'
          ? 'Pick one. Picking another swaps it.'
          : panel.style === 'buttons'
            ? 'Click a button to add or remove that role.'
            : 'Pick as many as you like. Unselect to remove.',
    };
    if (panel.style === 'buttons') {
      return {
        embed,
        buttons: panel.options.map((o) => ({
          customId: `rp:b:${panel.id}:${o.roleId}`,
          label: o.label,
          emoji: o.emoji,
          style: 'secondary' as const,
        })),
      };
    }
    return {
      embed,
      select: {
        customId: `rp:s:${panel.id}`,
        placeholder: panel.mode === 'single' ? 'Choose a role' : 'Choose your roles',
        minValues: 0,
        maxValues: panel.mode === 'single' ? 1 : panel.options.length,
        options: panel.options.map((o) => ({
          value: o.roleId,
          label: o.label,
          description: o.description,
          emoji: o.emoji,
        })),
      },
    };
  }

  private async member(userId: string) {
    const m = await this.d.guild.getMember(userId);
    if (!m) throw new UserError("I couldn't find you in this server.");
    return m;
  }

  /** A button click: toggle that role (single mode also removes the panel's other roles). */
  async handleButton(userId: string, panelId: number, roleId: string): Promise<string> {
    const panel = this.require(panelId);
    if (!panel.options.some((o) => o.roleId === roleId)) {
      throw new UserError("That role isn't on this panel any more.");
    }
    const problem = this.roleProblem(roleId);
    if (problem) throw new UserError(`I can't hand out ${mention(roleId)} right now: ${problem}.`);
    const member = await this.member(userId);
    const reason = `Role panel "${panel.title}"`;

    if (member.roleIds.includes(roleId)) {
      await this.d.mod.removeRole(userId, roleId, reason);
      return `Removed ${mention(roleId)}.`;
    }
    await this.d.mod.addRole(userId, roleId, reason);
    const removed: string[] = [];
    if (panel.mode === 'single') {
      for (const o of panel.options) {
        if (o.roleId === roleId || !member.roleIds.includes(o.roleId)) continue;
        if (this.roleProblem(o.roleId)) continue;
        await this.d.mod.removeRole(userId, o.roleId, reason);
        removed.push(o.roleId);
      }
    }
    return `Added ${mention(roleId)}.${removed.length ? ` Removed ${list(removed)}.` : ''}`;
  }

  /** A menu choice: the member ends up with exactly the selected roles from this panel. */
  async handleSelect(userId: string, panelId: number, values: string[]): Promise<string> {
    const panel = this.require(panelId);
    const offered = new Set(panel.options.map((o) => o.roleId));
    let wanted = values.filter((v) => offered.has(v));
    if (panel.mode === 'single') wanted = wanted.slice(0, 1);
    const want = new Set(wanted);
    const member = await this.member(userId);
    const reason = `Role panel "${panel.title}"`;

    const added: string[] = [];
    const removed: string[] = [];
    const blocked: string[] = [];
    for (const o of panel.options) {
      const has = member.roleIds.includes(o.roleId);
      if (has === want.has(o.roleId)) continue;
      if (this.roleProblem(o.roleId)) {
        blocked.push(o.roleId);
        continue;
      }
      if (has) {
        await this.d.mod.removeRole(userId, o.roleId, reason);
        removed.push(o.roleId);
      } else {
        await this.d.mod.addRole(userId, o.roleId, reason);
        added.push(o.roleId);
      }
    }
    const parts: string[] = [];
    if (added.length) parts.push(`Added ${list(added)}.`);
    if (removed.length) parts.push(`Removed ${list(removed)}.`);
    if (blocked.length) parts.push(`I can't change ${list(blocked)} right now.`);
    return parts.join(' ') || 'No changes. You already have those roles.';
  }
}
