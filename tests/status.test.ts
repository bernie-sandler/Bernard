import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  KumaError,
  type KumaMonitor,
  kumaApiUrl,
  parseKumaTime,
  toSnapshot,
} from '../src/services/status/kuma.js';
import { buildStatusEmbed, formatUptime, StatusService } from '../src/services/status/service.js';
import { OWNER_ID, testContainer } from './helpers.js';

let t: ReturnType<typeof testContainer>;
let statusChannel: string;
let alertChannel: string;
const ADMIN = { id: OWNER_ID, source: 'dashboard' as const };

const monitor = (
  id: number,
  name: string,
  status: KumaMonitor['status'],
  extra: Partial<KumaMonitor> = {},
) => ({
  id,
  name,
  group: 'Services',
  status,
  ping: 20,
  message: status === 'up' ? '200 - OK' : 'connect ECONNREFUSED',
  checkedAt: '2026-11-17T12:00:00.000Z',
  uptime24h: 0.9991,
  ...extra,
});

function setStatuses(...list: [number, string, KumaMonitor['status']][]) {
  t.kuma.snapshot = { title: 'Homelab', monitors: list.map(([id, name, s]) => monitor(id, name, s)) };
}

function configure(extra: (s: ReturnType<typeof t.services.settings.get>['status']) => void = () => {}) {
  t.services.settings.update(ADMIN, 'settings.status', (d) => {
    d.status.kumaUrl = 'http://tower:3001';
    d.status.slug = 'homelab';
    extra(d.status);
  });
}

beforeEach(() => {
  t = testContainer();
  statusChannel = t.guild.addChannel('status');
  alertChannel = t.guild.addChannel('alerts');
  setStatuses([1, 'Tower', 'up'], [2, 'Plex', 'up'], [3, 'Minecraft', 'up']);
});
afterEach(() => t.close());

describe('Kuma parsing', () => {
  const page = {
    config: { slug: 'homelab', title: 'Homelab' },
    publicGroupList: [
      { id: 1, name: 'Servers', monitorList: [{ id: 1, name: 'Tower', type: 'http' }] },
      {
        id: 2,
        name: 'Games',
        monitorList: [
          { id: 3, name: 'Minecraft', type: 'gamedig' },
          { id: 4, name: 'New', type: 'port' },
        ],
      },
    ],
  };
  const beats = {
    heartbeatList: {
      '1': [
        { status: 0, time: '2026-11-17 11:59:00.000', msg: 'down', ping: null },
        { status: 1, time: '2026-11-17 12:00:00.000', msg: '200 - OK', ping: 31.5 },
      ],
      '3': [{ status: 3, time: '2026-11-17 12:00:00', msg: '', ping: null }],
    },
    uptimeList: { '1_24': 0.998, '3_24': 1 },
  };

  it('combines groups, the latest heartbeat and 24h uptime', () => {
    const snap = toSnapshot(page, beats);
    expect(snap.title).toBe('Homelab');
    expect(snap.monitors).toEqual([
      {
        id: 1,
        name: 'Tower',
        group: 'Servers',
        status: 'up',
        ping: 31.5,
        message: '200 - OK',
        checkedAt: '2026-11-17T12:00:00.000Z',
        uptime24h: 0.998,
      },
      expect.objectContaining({ id: 3, group: 'Games', status: 'maintenance', uptime24h: 1 }),
      expect.objectContaining({ id: 4, status: 'unknown', checkedAt: null, uptime24h: null }),
    ]);
  });

  it('rejects responses that are not a Kuma status page', () => {
    expect(() => toSnapshot({ hello: 'world' }, beats)).toThrow(KumaError);
    expect(() => toSnapshot(page, { heartbeatList: 'nope' })).toThrow(KumaError);
  });

  it('reads Kuma times as UTC and keeps sub-paths in the base URL', () => {
    expect(parseKumaTime('2026-11-17 12:00:00')).toBe('2026-11-17T12:00:00.000Z');
    expect(parseKumaTime('2026-11-17T12:00:00+01:00')).toBe('2026-11-17T11:00:00.000Z');
    expect(parseKumaTime('garbage')).toBeNull();
    expect(kumaApiUrl('https://home.example.com/kuma', 'api/status-page/x')).toBe(
      'https://home.example.com/kuma/api/status-page/x',
    );
  });
});

describe('status embed', () => {
  it('summarises by group with ping and uptime', () => {
    const embed = buildStatusEmbed(
      {
        title: 'Homelab',
        monitors: [monitor(1, 'Tower', 'up'), monitor(2, 'Plex', 'down', { group: 'Media' })],
      },
      { error: null, errorSince: null, now: 0 },
    );
    expect(embed.description).toContain('**Plex** is down');
    expect(embed.fields?.map((f) => f.name)).toEqual(['Services', 'Media']);
    expect(embed.fields?.[0]?.value).toBe('🟢 **Tower** · 20 ms · 99.91% (24h)');
    expect(embed.fields?.[1]?.value).toContain('🔴 **Plex**');
    expect(formatUptime(1)).toBe('100%');
  });

  it("stays under Discord's embed limits and never hides a down monitor", () => {
    const monitors = Array.from({ length: 300 }, (_, i) =>
      monitor(i, `Service number ${i} with a long name`, i === 299 ? 'down' : 'up', { group: `G${i % 3}` }),
    );
    const embed = buildStatusEmbed({ title: 'Big', monitors }, { error: null, errorSince: null, now: 0 });
    const total =
      (embed.title?.length ?? 0) +
      (embed.description?.length ?? 0) +
      (embed.footer?.length ?? 0) +
      (embed.fields ?? []).reduce((n, f) => n + f.name.length + f.value.length, 0);
    expect(total).toBeLessThanOrEqual(6000);
    for (const f of embed.fields ?? []) expect(f.value.length).toBeLessThanOrEqual(1024);
    expect(embed.description).toContain('**Service number 299 with a long name** is down');
    expect(embed.fields?.[0]?.value).toMatch(/\+\d+ more$/);
  });

  it('posts and pins one message, then edits it in place', async () => {
    configure();
    await t.services.status.setChannel(ADMIN, statusChannel);
    let msgs = t.messenger.inChannel(statusChannel);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.pinned).toBe(true);
    expect(msgs[0]!.msg.embed?.description).toBe('Everything is up.');

    setStatuses([1, 'Tower', 'up'], [2, 'Plex', 'down'], [3, 'Minecraft', 'up']);
    await t.services.status.refresh();
    msgs = t.messenger.inChannel(statusChannel);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.msg.embed?.description).toContain('**Plex** is down');
  });

  it('reposts when the message was deleted and moves when the channel changes', async () => {
    configure();
    await t.services.status.setChannel(ADMIN, statusChannel);
    const first = t.messenger.inChannel(statusChannel)[0]!.id;
    t.messenger.messages.delete(first);
    await t.services.status.refresh();
    expect(t.messenger.inChannel(statusChannel)).toHaveLength(1);

    const other = t.guild.addChannel('status-2');
    await t.services.status.setChannel(ADMIN, other);
    expect(t.messenger.inChannel(statusChannel)).toHaveLength(0);
    expect(t.messenger.inChannel(other)).toHaveLength(1);
  });

  it('takes the embed down when Kuma is disconnected', async () => {
    configure();
    await t.services.status.setChannel(ADMIN, statusChannel);
    t.services.settings.update(ADMIN, 'settings.status', (d) => {
      d.status.kumaUrl = null;
      d.status.slug = null;
    });
    const view = await t.services.status.refresh();
    expect(view.message).toBeNull();
    expect(t.messenger.inChannel(statusChannel)).toHaveLength(0);
  });

  it('refuses a channel the bot cannot post in, and posting before Kuma is set up', async () => {
    await expect(t.services.status.setChannel(ADMIN, statusChannel)).rejects.toThrow(/Uptime Kuma URL/);
    configure();
    t.messenger.unsendable.add(statusChannel);
    await expect(t.services.status.setChannel(ADMIN, statusChannel)).rejects.toThrow(/can't post/);
  });

  it('keeps the last known state when Kuma is unreachable', async () => {
    configure();
    await t.services.status.setChannel(ADMIN, statusChannel);
    t.kuma.error = new KumaError("Couldn't reach Uptime Kuma (ECONNREFUSED).");
    const view = await t.services.status.refresh();
    expect(view.error).toContain('ECONNREFUSED');
    expect(view.snapshot?.monitors).toHaveLength(3);
    const embed = t.messenger.inChannel(statusChannel)[0]!.msg.embed!;
    expect(embed.description).toContain("Can't reach Uptime Kuma");
    expect(embed.fields?.[0]?.value).toContain('🟢 **Tower**');
  });

  it('refreshes on the configured interval only', async () => {
    let now = 1_000_000;
    const status = new StatusService({
      guild: t.guild,
      messenger: t.messenger,
      kuma: t.kuma,
      settings: t.services.settings,
      state: t.services.state,
      logger: t.services.logger,
      now: () => now,
    });
    expect(await status.maybeScheduledRefresh()).toBeNull(); // not configured
    configure((s) => {
      s.intervalSeconds = 300;
    });
    await status.maybeScheduledRefresh();
    expect(t.kuma.reads).toBe(1);
    now += 60_000;
    expect(await status.maybeScheduledRefresh()).toBeNull();
    now += 240_000;
    await status.maybeScheduledRefresh();
    expect(t.kuma.reads).toBe(2);
  });
});

describe('status alerts', () => {
  it('alerts on down and back up, pinging only the configured role', async () => {
    const mcRole = t.guild.addRole('MC updates');
    configure((s) => {
      s.alertChannelId = alertChannel;
    });
    t.services.status.setAlertRole(ADMIN, 3, mcRole);

    await t.services.status.refresh(); // baseline: no alerts on start-up
    expect(t.messenger.inChannel(alertChannel)).toHaveLength(0);

    setStatuses([1, 'Tower', 'up'], [2, 'Plex', 'up'], [3, 'Minecraft', 'down']);
    await t.services.status.refresh();
    let alerts = t.messenger.inChannel(alertChannel);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.msg.content).toBe(`<@&${mcRole}>`);
    expect(alerts[0]!.msg.mentionRoleIds).toEqual([mcRole]);
    expect(alerts[0]!.msg.embed?.title).toBe('🔴 Minecraft is down');

    await t.services.status.refresh(); // still down: nothing new
    expect(t.messenger.inChannel(alertChannel)).toHaveLength(1);

    setStatuses([1, 'Tower', 'up'], [2, 'Plex', 'down'], [3, 'Minecraft', 'up']);
    await t.services.status.refresh();
    alerts = t.messenger.inChannel(alertChannel);
    expect(alerts.map((a) => a.msg.embed?.title)).toEqual([
      '🔴 Minecraft is down',
      '🔴 Plex is down',
      '🟢 Minecraft is back up',
    ]);
    expect(alerts[1]!.msg.content).toBeUndefined(); // Plex has no role
    expect(alerts[1]!.msg.mentionRoleIds).toBeUndefined();
  });

  it('ignores pending blips and does not alert when switching status pages', async () => {
    configure((s) => {
      s.alertChannelId = alertChannel;
    });
    await t.services.status.refresh();
    setStatuses([1, 'Tower', 'pending'], [2, 'Plex', 'up'], [3, 'Minecraft', 'up']);
    await t.services.status.refresh();
    setStatuses([1, 'Tower', 'up'], [2, 'Plex', 'up'], [3, 'Minecraft', 'up']);
    await t.services.status.refresh();
    expect(t.messenger.inChannel(alertChannel)).toHaveLength(0);

    t.services.settings.update(ADMIN, 'settings.status', (d) => {
      d.status.slug = 'other';
    });
    setStatuses([1, 'Tower', 'down'], [2, 'Plex', 'down'], [3, 'Minecraft', 'down']);
    await t.services.status.refresh();
    expect(t.messenger.inChannel(alertChannel)).toHaveLength(0);
  });

  it('throws away a read of the old page when the page changes mid-read', async () => {
    configure((s) => {
      s.alertChannelId = alertChannel;
    });
    await t.services.status.refresh();
    let release!: () => void;
    const slow = new Promise<void>((r) => {
      release = r;
    });
    const original = t.kuma.fetchStatusPage.bind(t.kuma);
    t.kuma.fetchStatusPage = async () => {
      await slow;
      return { title: 'Old page', monitors: [monitor(1, 'Tower', 'down')] };
    };
    const inFlight = t.services.status.refresh();
    t.services.settings.update(ADMIN, 'settings.status', (d) => {
      d.status.slug = 'other';
    });
    t.kuma.fetchStatusPage = original;
    t.kuma.snapshot = { title: 'New page', monitors: [monitor(9, 'Plex', 'up')] };
    const after = t.services.status.refresh();
    release();
    await inFlight;
    const view = await after;
    expect(view.snapshot?.title).toBe('New page');
    expect(t.messenger.inChannel(alertChannel)).toHaveLength(0);
  });

  it('clears an alert role', () => {
    const role = t.guild.addRole('Movie night');
    t.services.status.setAlertRole(ADMIN, 2, role);
    expect(t.services.settings.get().status.alertRoles).toEqual({ '2': role });
    t.services.status.setAlertRole(ADMIN, 2, null);
    expect(t.services.settings.get().status.alertRoles).toEqual({});
    expect(() => t.services.status.setAlertRole(ADMIN, 2, '999999999999999999')).toThrow(/no longer exists/);
  });
});
