import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadEnv } from '../src/config/env.js';
import { issueReports } from '../src/db/schema.js';
import {
  BelltowerError,
  belltowerUrl,
  describeStatus,
  HttpBelltowerClient,
  parseTickets,
} from '../src/services/belltower/client.js';
import { plain, REPORT_BUTTON_ID } from '../src/services/belltower/service.js';
import type { KumaMonitor } from '../src/services/status/kuma.js';
import { apiHarness } from './apiHarness.js';
import { GUILD_ID, makeActor, OWNER_ID, testContainer } from './helpers.js';

const ADMIN = { id: OWNER_ID, source: 'system' as const };

let t: ReturnType<typeof testContainer>;
let channel: string;

const monitor = (id: number, name: string): KumaMonitor => ({
  id,
  name,
  group: 'Services',
  status: 'down',
  ping: null,
  message: '',
  checkedAt: null,
  uptime24h: null,
});

async function withKuma(...monitors: KumaMonitor[]) {
  t.kuma.snapshot = { title: 'Homelab', monitors };
  t.services.settings.update(ADMIN, 'settings.status', (d) => {
    d.status.kumaUrl = 'http://tower:3001';
    d.status.slug = 'homelab';
  });
  await t.services.status.refresh();
}

function reporter() {
  const m = t.guild.addMember({ displayName: 'Sam', username: 'sam' });
  return { userId: m.userId, username: m.username, displayName: m.displayName };
}

const rows = () => t.db.select().from(issueReports).all();

beforeEach(() => {
  t = testContainer();
  channel = t.guild.addChannel('general');
});
afterEach(() => t.close());

describe('Belltower client', () => {
  it('builds URLs under a sub-path', () => {
    expect(belltowerUrl('http://tower/belltower', 'api/v1/cards')).toBe(
      'http://tower/belltower/api/v1/cards',
    );
    expect(belltowerUrl('http://tower:8080/', 'api/v1/cards?ids=1')).toBe(
      'http://tower:8080/api/v1/cards?ids=1',
    );
  });

  it('explains HTTP errors', () => {
    expect(describeStatus(401, 'read')).toMatch(/rejected the token/);
    expect(describeStatus(403, 'write')).toMatch(/read-only/);
    expect(describeStatus(404, 'read')).toMatch(/1\.6/);
    expect(describeStatus(404, 'write')).toMatch(/BELLTOWER_URL/);
    expect(describeStatus(429, 'read', '12')).toMatch(/12s/);
    expect(describeStatus(502, 'read')).toBe('Belltower answered with HTTP 502.');
  });

  it('parses tickets and refuses answers that do not fit', () => {
    const ticket = {
      id: 4,
      ticketNo: '261117-4',
      title: 'Plex',
      state: 'done',
      resolution: 'Fixed',
      archivedAt: null,
      deletedAt: null,
      labels: ['Discord'],
    };
    expect(parseTickets({ cards: [ticket], more: false })).toEqual([
      {
        id: 4,
        ticketNo: '261117-4',
        title: 'Plex',
        state: 'done',
        resolution: 'Fixed',
        archivedAt: null,
        deletedAt: null,
      },
    ]);
    expect(() => parseTickets({ cards: [{ ...ticket, state: 'weird' }] })).toThrow(BelltowerError);
    expect(() => parseTickets({ nope: true })).toThrow(BelltowerError);
  });

  describe('over HTTP', () => {
    afterEach(() => vi.unstubAllGlobals());

    it('sends the token and the card, and maps the answer', async () => {
      const fetchMock = vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              status: 'updated',
              card: { id: 9, ticketNo: '261117-9', title: 'Plex is down', columnId: 1, completedAt: null },
            }),
            { status: 200 },
          ),
      );
      vi.stubGlobal('fetch', fetchMock);
      const client = new HttpBelltowerClient('http://bt:3000', 'tt_secret');
      const res = await client.openCard({ title: 'Plex', dedupeKey: 'uptime-kuma:2' });
      expect(res).toEqual({ status: 'updated', id: 9, ticketNo: '261117-9', title: 'Plex is down' });
      const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toBe('http://bt:3000/api/v1/cards');
      expect(init.method).toBe('POST');
      expect((init.headers as Record<string, string>).authorization).toBe('Bearer tt_secret');
      expect(JSON.parse(init.body as string)).toEqual({ title: 'Plex', dedupeKey: 'uptime-kuma:2' });
    });

    it('reads tickets 100 ids at a time', async () => {
      const fetchMock = vi.fn(async () => new Response(JSON.stringify({ cards: [] }), { status: 200 }));
      vi.stubGlobal('fetch', fetchMock);
      const client = new HttpBelltowerClient('http://bt:3000', 'tt_secret');
      await client.getCards(Array.from({ length: 150 }, (_, i) => i + 1));
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(String((fetchMock.mock.calls[1] as unknown[])[0])).toContain('ids=101,');
    });

    it('turns failures into readable errors', async () => {
      vi.stubGlobal('fetch', async () => new Response('{}', { status: 404 }));
      const client = new HttpBelltowerClient('http://bt:3000', 'tt_secret');
      await expect(client.ping()).rejects.toThrow(/1\.6/);

      vi.stubGlobal(
        'fetch',
        async () =>
          new Response(JSON.stringify({ error: 'validation', message: 'Bad column' }), { status: 400 }),
      );
      await expect(client.openCard({ title: 'x' })).rejects.toThrow(
        "Belltower didn't accept the report: Bad column",
      );

      vi.stubGlobal('fetch', async () => {
        throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
      });
      await expect(client.ping()).rejects.toThrow("Couldn't reach Belltower (ECONNREFUSED).");
    });
  });
});

describe('env', () => {
  const base = {
    DISCORD_TOKEN: 'x'.repeat(70),
    DISCORD_CLIENT_ID: '123456789012345678',
    GUILD_ID,
    DASHBOARD_ENABLED: 'false',
  };

  it('is optional, and strips a trailing slash', () => {
    expect(loadEnv(base).BELLTOWER_URL).toBeUndefined();
    const env = loadEnv({ ...base, BELLTOWER_URL: 'http://bt:3000/', BELLTOWER_TOKEN: 'tt_abc' });
    expect(env.BELLTOWER_URL).toBe('http://bt:3000');
    expect(env.BELLTOWER_TOKEN).toBe('tt_abc');
  });

  it('needs both, and a real token', () => {
    expect(() => loadEnv({ ...base, BELLTOWER_URL: 'http://bt:3000' })).toThrow(/BELLTOWER_TOKEN/);
    expect(() => loadEnv({ ...base, BELLTOWER_URL: 'http://bt', BELLTOWER_TOKEN: 'abc' })).toThrow(/tt_/);
  });
});

describe('reporting', () => {
  it('opens a ticket for a free-text service', async () => {
    const r = reporter();
    const reply = await t.services.belltower.report(r, {
      service: 'Nextcloud',
      details: 'Login page\nspins forever',
      channelId: channel,
    });
    expect(reply).toContain('261117-1');
    const card = t.belltower.opened[0]!;
    expect(card.title).toBe('Nextcloud: Login page spins forever');
    expect(card.dedupeKey).toBeUndefined();
    expect(card.labels).toEqual(['Discord']);
    expect(card.description).toContain('**Sam** (@sam) in #general');
    expect(rows()).toMatchObject([
      { reporterId: r.userId, cardId: 1, cardStatus: 'created', state: 'received' },
    ]);
  });

  it("joins Kuma's ticket for a monitor, by id or by name", async () => {
    await withKuma(monitor(7, 'Plex'));
    const a = await t.services.belltower.report(reporter(), { service: '7', channelId: channel });
    const b = await t.services.belltower.report(reporter(), { service: 'plex', channelId: channel });
    expect(t.belltower.opened.map((c) => c.dedupeKey)).toEqual(['uptime-kuma:7', 'uptime-kuma:7']);
    expect(t.belltower.opened[0]!.title).toBe("Plex isn't working");
    expect(a).toMatch(/opened ticket/);
    expect(b).toMatch(/already being looked at/);
    expect(rows().map((x) => [x.cardId, x.cardStatus, x.monitorId])).toEqual([
      [1, 'created', 7],
      [1, 'updated', 7],
    ]);
  });

  it('applies the configured tags, priority and column', async () => {
    t.services.settings.update(ADMIN, 'settings.belltower', (d) => {
      d.belltower.labels = [];
      d.belltower.priority = 'P1';
      d.belltower.column = 'Triage';
    });
    await t.services.belltower.report(reporter(), { service: 'Plex', channelId: null });
    const card = t.belltower.opened[0]!;
    expect(card.labels).toBeUndefined();
    expect(card).toMatchObject({ priority: 'P1', column: 'Triage' });
  });

  it('enforces a cooldown per member', async () => {
    const r = reporter();
    await t.services.belltower.report(r, { service: 'Plex', channelId: null });
    await expect(t.services.belltower.report(r, { service: 'Sonarr', channelId: null })).rejects.toThrow(
      /just sent a report/,
    );
    await t.services.belltower.report(reporter(), { service: 'Sonarr', channelId: null }); // others aren't blocked
    t.services.settings.update(ADMIN, 'settings.belltower', (d) => {
      d.belltower.cooldownSeconds = 0;
    });
    await t.services.belltower.report(r, { service: 'Sonarr', channelId: null });
    expect(t.belltower.opened).toHaveLength(3);
  });

  it('refuses when paused, unconfigured, or Belltower fails', async () => {
    t.services.settings.update(ADMIN, 'settings.belltower', (d) => {
      d.belltower.enabled = false;
    });
    await expect(
      t.services.belltower.report(reporter(), { service: 'Plex', channelId: null }),
    ).rejects.toThrow(/paused/);
    t.services.settings.update(ADMIN, 'settings.belltower', (d) => {
      d.belltower.enabled = true;
    });
    t.belltower.error = new BelltowerError('down');
    await expect(
      t.services.belltower.report(reporter(), { service: 'Plex', channelId: null }),
    ).rejects.toThrow(/couldn't file your report/);
    expect(rows()).toHaveLength(0);

    const off = testContainer(undefined, { belltower: false });
    await expect(
      off.services.belltower.report(reporter(), { service: 'Plex', channelId: null }),
    ).rejects.toThrow(/isn't set up/);
    off.close();
  });

  it('lets one report per member through at a time', async () => {
    const r = reporter();
    const [first, second] = await Promise.allSettled([
      t.services.belltower.report(r, { service: 'Plex', channelId: null }),
      t.services.belltower.report(r, { service: 'Plex', channelId: null }),
    ]);
    expect(first.status).toBe('fulfilled');
    expect(second).toMatchObject({
      status: 'rejected',
      reason: { message: expect.stringMatching(/still being sent/) },
    });
    expect(t.belltower.opened).toHaveLength(1);
  });

  it('says up front why the panel form would be refused', () => {
    expect(t.services.belltower.unavailableReason()).toBeNull();
    t.services.settings.update(ADMIN, 'settings.belltower', (d) => {
      d.belltower.enabled = false;
    });
    expect(t.services.belltower.unavailableReason()).toMatch(/paused/);
    const off = testContainer(undefined, { belltower: false });
    expect(off.services.belltower.unavailableReason()).toMatch(/isn't set up/);
    off.close();
  });

  it('works as /report, with monitor autocomplete', async () => {
    await withKuma(monitor(7, 'Plex'), monitor(8, 'Sonarr'));
    const member = t.guild.addMember();
    const command = t.services.registry.find('report')!;
    const choices = await command.leaf.autocomplete!.service!(
      { guildId: GUILD_ID, actor: makeActor(member), services: t.services },
      'son',
    );
    expect(choices).toEqual([{ name: 'Sonarr', value: '8' }]);
    const res = await t.executor.run({
      command,
      actor: makeActor(member),
      source: 'slash',
      rawInput: { service: '8', details: 'no downloads' },
      channelId: channel,
    });
    expect(res.result.ok).toBe(true);
    expect(rows()[0]).toMatchObject({ reporterId: member.userId, channelId: channel, monitorId: 8 });
  });
});

describe('following up', () => {
  it('tracks progress and DMs the reporter when done', async () => {
    const r = reporter();
    await t.services.belltower.report(r, { service: 'Plex', channelId: channel });
    t.belltower.setState(1, 'in_progress');
    expect(await t.services.belltower.poll()).toBe(0);
    expect(rows()[0]!.state).toBe('in_progress');
    expect(t.mod.callsTo('dm')).toHaveLength(0);

    t.belltower.setState(1, 'done', 'Fixed');
    expect(await t.services.belltower.poll()).toBe(1);
    expect(rows()[0]).toMatchObject({ state: 'done', resolution: 'Fixed', notifiedVia: 'dm' });
    expect(rows()[0]!.closedAt).not.toBeNull();
    const [dm] = t.mod.callsTo('dm');
    expect(dm!.args[0]).toBe(r.userId);
    expect(dm!.args[1]).toMatch(/Plex.*261117-1.*resolved: Fixed/);

    expect(await t.services.belltower.poll()).toBe(0); // closed reports aren't read again
    expect(t.mod.callsTo('dm')).toHaveLength(1);
  });

  it('mentions the reporter in the channel when DMs are closed', async () => {
    const r = reporter();
    await t.services.belltower.report(r, { service: 'Plex', channelId: channel });
    t.mod.dmsOpen = false;
    t.belltower.setState(1, 'done');
    await t.services.belltower.poll();
    const [msg] = t.messenger.inChannel(channel);
    expect(msg!.msg.content).toMatch(new RegExp(`^<@${r.userId}> .*resolved\\.$`));
    expect(msg!.msg.mentionUserIds).toEqual([r.userId]);
    expect(rows()[0]!.notifiedVia).toBe('channel');
  });

  it('records when nobody could be told', async () => {
    await t.services.belltower.report(reporter(), { service: 'Plex', channelId: channel });
    t.mod.dmsOpen = false;
    t.messenger.unsendable.add(channel);
    t.belltower.setState(1, 'done');
    await t.services.belltower.poll();
    expect(rows()[0]!.notifiedVia).toBe('none');
  });

  it('closes reports whose ticket was deleted or is gone', async () => {
    await t.services.belltower.report(reporter(), { service: 'Plex', channelId: null });
    await t.services.belltower.report(reporter(), { service: 'Sonarr', channelId: null });
    t.belltower.tickets.get(1)!.deletedAt = '2026-11-17T10:00:00.000Z';
    t.belltower.tickets.delete(2);
    expect(await t.services.belltower.poll()).toBe(2);
    expect(rows().map((x) => x.state)).toEqual(['deleted', 'missing']);
    expect(t.mod.callsTo('dm').map((c) => c.args[1])).toEqual([
      expect.stringMatching(/was closed/),
      expect.stringMatching(/was closed/),
    ]);
  });

  it('closes nothing while Belltower is unreachable', async () => {
    await t.services.belltower.report(reporter(), { service: 'Plex', channelId: null });
    t.belltower.error = new BelltowerError("Couldn't reach Belltower (timed out).");
    expect(await t.services.belltower.poll()).toBe(0);
    expect(rows()[0]!.closedAt).toBeNull();
    expect(t.services.belltower.view().error).toMatch(/timed out/);
    t.belltower.error = null;
    t.belltower.setState(1, 'done');
    expect(await t.services.belltower.poll()).toBe(1);
    expect(t.services.belltower.view().error).toBeNull();
  });

  it('tells everyone who reported a shared ticket, once each', async () => {
    t.services.settings.update(ADMIN, 'settings.belltower', (d) => {
      d.belltower.cooldownSeconds = 0;
    });
    await withKuma(monitor(7, 'Plex'));
    const a = reporter();
    const b = reporter();
    await t.services.belltower.report(a, { service: '7', channelId: null });
    await t.services.belltower.report(b, { service: '7', channelId: null });
    await t.services.belltower.report(a, { service: '7', channelId: null }); // again: no second DM
    t.belltower.setState(1, 'done');
    await t.services.belltower.poll();
    expect(t.mod.callsTo('dm').map((c) => c.args[0])).toEqual([a.userId, b.userId]);
    expect(rows().map((x) => x.state)).toEqual(['done', 'done', 'duplicate']);
  });

  it('closes archived tickets that were never completed', async () => {
    await t.services.belltower.report(reporter(), { service: 'Plex', channelId: null });
    t.belltower.tickets.get(1)!.archivedAt = '2026-11-17T10:00:00.000Z';
    expect(await t.services.belltower.poll()).toBe(1);
    expect(rows()[0]!.state).toBe('archived');
    expect(t.mod.callsTo('dm')[0]!.args[1]).toMatch(/was closed/);
  });

  it('never echoes links or mentions from a report', async () => {
    t.mod.dmsOpen = false;
    const r = reporter();
    await t.services.belltower.report(r, {
      service: '[Free Nitro](https://evil.example) <@&123>',
      channelId: channel,
    });
    t.belltower.setState(1, 'done', '**[x](https://evil.example)**');
    await t.services.belltower.poll();
    const content = t.messenger.inChannel(channel)[0]!.msg.content!;
    expect(content.startsWith(`<@${r.userId}> `)).toBe(true);
    const echoed = content.slice(`<@${r.userId}> `.length);
    for (const ch of ['[', ']', '<', '>', '@']) expect(echoed).not.toContain(ch);
    expect(echoed).not.toContain('](');
    expect(plain('<#1> @everyone [a](b)')).toBe('1 everyone ab');
  });

  it('does not notify a report dismissed while Belltower is being read', async () => {
    await t.services.belltower.report(reporter(), { service: 'Plex', channelId: null });
    t.belltower.setState(1, 'done');
    const read = t.belltower.getCards.bind(t.belltower);
    t.belltower.getCards = async (ids) => {
      const res = await read(ids);
      t.services.belltower.dismiss([1]);
      return res;
    };
    expect(await t.services.belltower.poll()).toBe(0);
    expect(rows()[0]!.state).toBe('dismissed');
    expect(t.mod.callsTo('dm')).toHaveLength(0);
  });

  it('clears an old error once Belltower answers again, even with nothing open', async () => {
    await t.services.belltower.report(reporter(), { service: 'Plex', channelId: null });
    t.belltower.error = new BelltowerError('down');
    await t.services.belltower.poll();
    t.services.belltower.dismiss([1]);
    await t.services.belltower.poll();
    expect(t.services.belltower.view().error).toBe('down');
    t.belltower.error = null;
    await t.services.belltower.poll();
    expect(t.services.belltower.view().error).toBeNull();
  });

  it('can stop following a report', async () => {
    await t.services.belltower.report(reporter(), { service: 'Plex', channelId: null });
    expect(t.services.belltower.dismiss([1])).toBe(1);
    t.belltower.setState(1, 'done');
    await t.services.belltower.poll();
    expect(t.mod.callsTo('dm')).toHaveLength(0);
    expect(t.services.belltower.list().recent[0]!.state).toBe('dismissed');
  });
});

describe('report panel', () => {
  it('posts, moves and removes the panel', async () => {
    const other = t.guild.addChannel('help');
    await t.services.belltower.setPanelChannel(ADMIN, channel);
    const [posted] = t.messenger.inChannel(channel);
    expect(posted!.msg.buttons).toEqual([expect.objectContaining({ customId: REPORT_BUTTON_ID })]);

    await t.services.belltower.setPanelChannel(ADMIN, other);
    expect(t.messenger.inChannel(channel)).toHaveLength(0);
    expect(t.messenger.inChannel(other)).toHaveLength(1);

    await t.services.belltower.setPanelChannel(ADMIN, null);
    expect(t.messenger.inChannel(other)).toHaveLength(0);
    expect(t.services.belltower.view().panel).toBeNull();
  });

  it("re-posts the panel if it was deleted, and explains when it can't post", async () => {
    await t.services.belltower.setPanelChannel(ADMIN, channel);
    const [first] = t.messenger.inChannel(channel);
    await t.messenger.delete(channel, first!.id);
    await t.services.belltower.syncPanel();
    expect(t.messenger.inChannel(channel)).toHaveLength(1);

    const locked = t.guild.addChannel('locked');
    t.messenger.unsendable.add(locked);
    await expect(t.services.belltower.setPanelChannel(ADMIN, locked)).rejects.toThrow(/can't post/);
    await expect(
      t.services.belltower.setPanelChannel(ADMIN, t.guild.addChannel('vc', 'voice')),
    ).rejects.toThrow(/text or announcement/);
  });
});

describe('dashboard routes', () => {
  let h: Awaited<ReturnType<typeof apiHarness>>;
  beforeEach(async () => {
    h = await apiHarness();
  });
  afterEach(() => h.close());

  it('needs config:belltower', async () => {
    const role = h.t.guild.addRole('Staff', 20);
    h.t.services.permissions.setRule(ADMIN, role, 'dashboard:access', true);
    const m = h.t.guild.addMember({ roleIds: [role], highestRolePosition: 20 });
    const c = await h.as(m.userId);
    expect((await c.get('/api/belltower')).statusCode).toBe(403);
  });

  it('shows reports and saves settings', async () => {
    const m = h.t.guild.addMember({ displayName: 'Sam' });
    await h.t.services.belltower.report(
      { userId: m.userId, username: m.username, displayName: m.displayName },
      { service: 'Plex', channelId: null },
    );
    const c = await h.owner();
    const res = await c.get('/api/belltower');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      configured: true,
      config: { enabled: true, labels: ['Discord'], cooldownSeconds: 120 },
      open: [{ service: 'Plex', reporterName: 'Sam', ticketNo: '261117-1', state: 'received' }],
      recent: [],
    });

    const saved = await c.send('PATCH', '/api/belltower/config', {
      enabled: false,
      labels: ['Discord', ' Plex ', 'Discord'],
      priority: 'P2',
      column: '',
      cooldownSeconds: 30,
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().config).toEqual({
      enabled: false,
      labels: ['Discord', 'Plex'],
      priority: 'P2',
      column: null,
      cooldownSeconds: 30,
      panelChannelId: null,
    });
    const bad = await c.send('PATCH', '/api/belltower/config', { enabled: true });
    expect(bad.statusCode).toBe(400);

    const dismissed = await c.send('POST', `/api/belltower/reports/${res.json().open[0].id}/dismiss`);
    expect(dismissed.json()).toMatchObject({ open: [], recent: [{ state: 'dismissed' }] });
    expect((await c.send('POST', '/api/belltower/reports/1/dismiss')).statusCode).toBe(404);
  });

  it('tests the connection and polls on demand', async () => {
    const c = await h.owner();
    h.t.belltower.error = new BelltowerError('Belltower rejected the token.');
    const failed = await c.send('POST', '/api/belltower/test');
    expect(failed.statusCode).toBe(400);
    expect(failed.json().error).toMatch(/rejected the token/);
    h.t.belltower.error = null;
    expect((await c.send('POST', '/api/belltower/test')).json().error).toBeNull();
    expect((await c.send('POST', '/api/belltower/poll')).statusCode).toBe(200);
  });
});

describe('settings migration', () => {
  it('gives existing installs the defaults', () => {
    const s = t.services.settings.get().belltower;
    expect(s).toEqual({
      enabled: true,
      labels: ['Discord'],
      priority: null,
      column: null,
      cooldownSeconds: 120,
      panelChannelId: null,
    });
  });
});
