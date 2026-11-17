import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parsePanelCustomId } from '../src/services/rolePanels.js';
import { apiHarness } from './apiHarness.js';
import { GUILD_ID, OWNER_ID, testContainer } from './helpers.js';

let t: ReturnType<typeof testContainer>;
let channel: string;
let games: { minecraft: string; valorant: string; rust: string };
const ADMIN = { id: OWNER_ID, source: 'dashboard' as const };

const opt = (roleId: string, label: string) => ({ roleId, label });
const svc = () => t.services.rolePanels;

beforeEach(() => {
  t = testContainer();
  channel = t.guild.addChannel('roles');
  games = {
    minecraft: t.guild.addRole('Minecraft', 5),
    valorant: t.guild.addRole('Valorant', 6),
    rust: t.guild.addRole('Rust', 7),
  };
});
afterEach(() => t.close());

const gamesPanel = (extra: Record<string, unknown> = {}) =>
  svc().create(ADMIN, {
    title: 'Games',
    options: [opt(games.minecraft, 'Minecraft'), opt(games.valorant, 'Valorant'), opt(games.rust, 'Rust')],
    ...extra,
  });

describe('which roles can be offered', () => {
  it('rejects @everyone, managed, elevated and too-high roles', () => {
    const managed = t.guild.addRole('Booster', 3, { managed: true });
    const mod = t.guild.addRole('Mods', 4, { elevated: true });
    const high = t.guild.addRole('Above bot', 60);
    expect(svc().roleProblem(games.minecraft)).toBeNull();
    expect(svc().roleProblem(GUILD_ID)).toMatch(/@everyone/);
    expect(svc().roleProblem(managed)).toMatch(/managed/);
    expect(svc().roleProblem(mod)).toMatch(/moderator or admin/);
    expect(svc().roleProblem(high)).toMatch(/highest role/);
    expect(svc().roleProblem('999999999999999999')).toMatch(/no longer exists/);
    expect(() => svc().create(ADMIN, { title: 'Bad', options: [opt(mod, 'Mods')] })).toThrow(
      /can't be offered/,
    );
  });

  it('validates the panel itself', () => {
    expect(() => svc().create(ADMIN, { title: 'Empty', options: [] })).toThrow(/at least one role/);
    expect(() =>
      svc().create(ADMIN, {
        title: 'Dupes',
        options: [opt(games.rust, 'A'), opt(games.rust, 'B')],
      }),
    ).toThrow(/once/);
    expect(() =>
      svc().create(ADMIN, { title: 'Emoji', options: [{ ...opt(games.rust, 'Rust'), emoji: 'rust' }] }),
    ).toThrow(/emoji/);
  });
});

describe('posting', () => {
  it('renders buttons or a menu and moves the message when reposted', async () => {
    const p = gamesPanel();
    await svc().post(ADMIN, p.id, channel);
    const [msg] = t.messenger.inChannel(channel);
    expect(msg!.msg.buttons?.map((b) => b.customId)).toEqual([
      `rp:b:${p.id}:${games.minecraft}`,
      `rp:b:${p.id}:${games.valorant}`,
      `rp:b:${p.id}:${games.rust}`,
    ]);

    await svc().update(ADMIN, p.id, {
      title: 'Games',
      style: 'select',
      mode: 'single',
      options: [opt(games.minecraft, 'Minecraft'), opt(games.rust, 'Rust')],
    });
    const edited = t.messenger.inChannel(channel)[0]!.msg;
    expect(edited.buttons).toBeUndefined();
    expect(edited.select).toMatchObject({ customId: `rp:s:${p.id}`, minValues: 1, maxValues: 1 });

    const other = t.guild.addChannel('roles-2');
    await svc().post(ADMIN, p.id, other);
    expect(t.messenger.inChannel(channel)).toHaveLength(0);
    expect(t.messenger.inChannel(other)).toHaveLength(1);
    expect(svc().get(p.id)?.channelId).toBe(other);
  });

  it('forgets a posted message that was deleted in Discord', async () => {
    const p = gamesPanel();
    await svc().post(ADMIN, p.id, channel);
    t.messenger.messages.clear();
    await expect(svc().refresh(p.id)).rejects.toThrow(/deleted/);
    expect(svc().get(p.id)?.channelId).toBeNull();
  });

  it('deletes the message with the panel', async () => {
    const p = gamesPanel();
    await svc().post(ADMIN, p.id, channel);
    await svc().remove(ADMIN, p.id);
    expect(t.messenger.inChannel(channel)).toHaveLength(0);
    expect(svc().list()).toHaveLength(0);
  });
});

describe('clicking', () => {
  it('buttons toggle a role', async () => {
    const p = gamesPanel();
    const m = t.guild.addMember();
    expect(await svc().handleButton(m.userId, p.id, games.rust)).toBe(`Added <@&${games.rust}>.`);
    expect(m.roleIds).toContain(games.rust);
    expect(await svc().handleButton(m.userId, p.id, games.rust)).toBe(`Removed <@&${games.rust}>.`);
    expect(m.roleIds).not.toContain(games.rust);
    expect(t.mod.callsTo('addRole')[0]!.args[2]).toBe('Role panel "Games"');
  });

  it('single mode swaps roles', async () => {
    const p = gamesPanel({ mode: 'single' });
    const m = t.guild.addMember({ roleIds: [games.minecraft] });
    const reply = await svc().handleButton(m.userId, p.id, games.valorant);
    expect(reply).toBe(`Added <@&${games.valorant}>. Removed <@&${games.minecraft}>.`);
    expect(m.roleIds).toContain(games.valorant);
    expect(m.roleIds).not.toContain(games.minecraft);
  });

  it('menus toggle each picked role and leave the rest alone', async () => {
    const p = gamesPanel({ style: 'select' });
    const outside = t.guild.addRole('Unrelated', 2);
    const m = t.guild.addMember({ roleIds: [games.minecraft, outside] });
    // Picking Valorant must not strip Minecraft (the menu can't show what the member already has).
    expect(await svc().handleSelect(m.userId, p.id, [games.valorant, outside])).toBe(
      `Added <@&${games.valorant}>.`,
    );
    expect(new Set(m.roleIds)).toEqual(new Set([GUILD_ID, outside, games.minecraft, games.valorant]));
    expect(await svc().handleSelect(m.userId, p.id, [games.minecraft, games.rust])).toBe(
      `Added <@&${games.rust}>. Removed <@&${games.minecraft}>.`,
    );
    expect(await svc().handleSelect(m.userId, p.id, [])).toBe('Nothing picked.');
  });

  it('single-mode menus swap like buttons', async () => {
    const p = gamesPanel({ style: 'select', mode: 'single' });
    const m = t.guild.addMember({ roleIds: [games.minecraft] });
    expect(await svc().handleSelect(m.userId, p.id, [games.rust])).toBe(
      `Added <@&${games.rust}>. Removed <@&${games.minecraft}>.`,
    );
  });

  it("handles one member's quick double click in order", async () => {
    const p = gamesPanel({ mode: 'single' });
    const m = t.guild.addMember();
    const [a, b] = await Promise.all([
      svc().handleButton(m.userId, p.id, games.minecraft),
      svc().handleButton(m.userId, p.id, games.rust),
    ]);
    expect(a).toBe(`Added <@&${games.minecraft}>.`);
    expect(b).toBe(`Added <@&${games.rust}>. Removed <@&${games.minecraft}>.`);
    expect(m.roleIds.filter((r) => Object.values(games).includes(r))).toEqual([games.rust]);
  });

  it('re-checks roles on every click', async () => {
    const p = gamesPanel();
    const m = t.guild.addMember();
    t.guild.roles.get(games.rust)!.elevated = true; // someone gave the role Ban Members later
    await expect(svc().handleButton(m.userId, p.id, games.rust)).rejects.toThrow(/moderator or admin/);
    expect(await svc().handleSelect(m.userId, p.id, [games.rust, games.minecraft])).toBe(
      `Added <@&${games.minecraft}>. I can't change <@&${games.rust}> right now.`,
    );
    expect(m.roleIds).not.toContain(games.rust);
    await expect(svc().handleButton(m.userId, 9999, games.rust)).rejects.toThrow(/no longer exists/);
  });

  it('parses custom IDs strictly', () => {
    expect(parsePanelCustomId('rp:b:3:123456789012345678')).toEqual({
      kind: 'button',
      panelId: 3,
      roleId: '123456789012345678',
    });
    expect(parsePanelCustomId('rp:s:3')).toEqual({ kind: 'select', panelId: 3 });
    expect(parsePanelCustomId('rp:b:3:abc')).toBeNull();
    expect(parsePanelCustomId('other:thing')).toBeNull();
  });
});

describe('dashboard routes', () => {
  it('manages panels and status behind their permission nodes', async () => {
    const h = await apiHarness();
    try {
      const role = h.t.guild.addRole('Movie night', 5);
      const roomId = h.t.guild.addChannel('roles');
      const owner = await h.owner();
      const staffRole = h.t.guild.addRole('Staff', 10);
      h.t.services.permissions.setRule(
        { id: OWNER_ID, source: 'system' },
        staffRole,
        'dashboard:access',
        true,
      );
      const member = await h.as(h.t.guild.addMember({ roleIds: [staffRole] }).userId);

      expect((await member.get('/api/role-panels')).statusCode).toBe(403);
      expect((await member.get('/api/status')).statusCode).toBe(403);

      const created = await owner.send('POST', '/api/role-panels', {
        title: 'Pings',
        options: [{ roleId: role, label: 'Movie night', emoji: '🎬' }],
      });
      expect(created.statusCode).toBe(200);
      const id = created.json().id;
      const posted = await owner.send('POST', `/api/role-panels/${id}/post`, { channelId: roomId });
      expect(posted.json().channelName).toBe('roles');
      const list = (await owner.get('/api/role-panels')).json();
      expect(list.panels).toHaveLength(1);
      expect(list.roles.find((r: { id: string }) => r.id === role).problem).toBeNull();

      const bad = await owner.send('POST', '/api/role-panels', { title: 'x', options: [] });
      expect(bad.statusCode).toBe(400);

      const status = h.t.guild.addChannel('status');
      h.t.kuma.snapshot = {
        title: 'Homelab',
        monitors: [
          {
            id: 7,
            name: 'Plex',
            group: 'Media',
            status: 'up',
            ping: 12,
            message: '',
            checkedAt: null,
            uptime24h: 1,
          },
        ],
      };
      const cfg = await owner.send('PATCH', '/api/status/config', {
        kumaUrl: 'http://tower:3001/',
        slug: 'homelab',
        intervalSeconds: 60,
        alertChannelId: null,
      });
      expect(cfg.statusCode).toBe(200);
      expect(cfg.json().config.kumaUrl).toBe('http://tower:3001');
      expect(cfg.json().monitors[0].name).toBe('Plex');

      const pinned = await owner.send('PATCH', '/api/status/channel', { channelId: status });
      expect(pinned.json().message.channelId).toBe(status);
      const withRole = await owner.send('PATCH', '/api/status/monitors/7/role', { roleId: role });
      expect(withRole.json().monitors[0].alertRoleId).toBe(role);

      h.t.kuma.error = new Error('boom');
      const test = await owner.send('POST', '/api/status/test', { kumaUrl: 'http://x:1', slug: 'y' });
      expect(test.statusCode).toBe(400);
      const badUrl = await owner.send('POST', '/api/status/test', { kumaUrl: 'file:///etc', slug: 'y' });
      expect(badUrl.statusCode).toBe(400);
    } finally {
      await h.close();
    }
  });
});
