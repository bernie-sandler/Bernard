import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Services } from '../services/container.js';
import { panelInputSchema, type RolePanel } from '../services/rolePanels.js';
import { KumaError } from '../services/status/kuma.js';
import type { RolePanelDto, RolePanelsResponse, StatusResponse, StatusTestResponse } from '../shared/api.js';
import { gate, HttpError, parseInput, requireActor } from './http.js';

const snowflake = z.string().regex(/^\d{17,20}$/, 'must be a Discord ID');
const kumaUrl = z
  .url({ protocol: /^https?$/, error: 'must be an http(s) URL' })
  .max(500)
  .transform((u) => u.replace(/\/+$/, ''));
const kumaSlug = z
  .string()
  .trim()
  .regex(/^[a-zA-Z0-9_-]{1,100}$/, 'must be a status page slug');
const numericId = z.object({ id: z.coerce.number().int().min(0).max(9_999_999_999) });

/** Status embed (Uptime Kuma) and self-assign role panel routes, mounted under /api. */
export function registerIntegrationRoutes(api: FastifyInstance, services: Services): void {
  const auditActor = (req: FastifyRequest) => ({
    id: requireActor(req).userId,
    source: 'dashboard' as const,
  });

  // ── Status embed (config:status, same as /status setup) ──

  const statusGate = { preHandler: gate(services, 'config:status') };

  const statusResponse = (): StatusResponse => {
    const s = services.settings.get().status;
    const view = services.status.view();
    return {
      config: {
        kumaUrl: s.kumaUrl,
        slug: s.slug,
        channelId: s.channelId,
        intervalSeconds: s.intervalSeconds,
        alertChannelId: s.alertChannelId,
      },
      configured: view.configured,
      title: view.snapshot?.title ?? null,
      monitors: (view.snapshot?.monitors ?? []).map((m) => ({
        ...m,
        alertRoleId: s.alertRoles[String(m.id)] ?? null,
      })),
      fetchedAt: view.fetchedAt,
      error: view.error,
      errorSince: view.errorSince,
      message: view.message,
    };
  };

  const testKuma = async (url: string, slug: string) => {
    try {
      return await services.status.test(url, slug);
    } catch (err) {
      if (err instanceof KumaError) throw new HttpError(400, err.message);
      throw new HttpError(400, "Couldn't read that status page. Check the URL and slug.");
    }
  };

  api.get('/status', statusGate, async (): Promise<StatusResponse> => {
    const view = services.status.view();
    // First visit after start-up: read Kuma so the page isn't empty.
    if (view.configured && !view.fetchedAt && !view.error) await services.status.refresh();
    return statusResponse();
  });

  api.post('/status/test', statusGate, async (req): Promise<StatusTestResponse> => {
    const body = parseInput(z.object({ kumaUrl, slug: kumaSlug }), req.body);
    const snap = await testKuma(body.kumaUrl, body.slug);
    return { title: snap.title, monitors: snap.monitors.length };
  });

  api.patch('/status/config', statusGate, async (req): Promise<StatusResponse> => {
    const body = parseInput(
      z.object({
        kumaUrl: kumaUrl.nullable(),
        slug: kumaSlug.nullable(),
        intervalSeconds: z.number().int().min(60).max(3600),
        alertChannelId: snowflake.nullable(),
      }),
      req.body,
    );
    if ((body.kumaUrl === null) !== (body.slug === null)) {
      throw new HttpError(400, 'Set both the Uptime Kuma URL and the status page slug, or neither.');
    }
    const current = services.settings.get().status;
    if (body.kumaUrl && body.slug && (body.kumaUrl !== current.kumaUrl || body.slug !== current.slug)) {
      await testKuma(body.kumaUrl, body.slug); // don't save a page we can't read
    }
    services.settings.update(auditActor(req), 'settings.status', (draft) => {
      draft.status.kumaUrl = body.kumaUrl;
      draft.status.slug = body.slug;
      draft.status.intervalSeconds = body.intervalSeconds;
      draft.status.alertChannelId = body.alertChannelId;
      if (!body.kumaUrl) draft.status.channelId = null; // nothing to show any more
    });
    await services.status.refresh();
    return statusResponse();
  });

  api.patch('/status/channel', statusGate, async (req): Promise<StatusResponse> => {
    const body = parseInput(z.object({ channelId: snowflake.nullable() }), req.body);
    await services.status.setChannel(auditActor(req), body.channelId);
    return statusResponse();
  });

  api.patch('/status/monitors/:id/role', statusGate, async (req): Promise<StatusResponse> => {
    const { id } = parseInput(numericId, req.params);
    const body = parseInput(z.object({ roleId: snowflake.nullable() }), req.body);
    services.status.setAlertRole(auditActor(req), id, body.roleId);
    return statusResponse();
  });

  api.post('/status/refresh', statusGate, async (): Promise<StatusResponse> => {
    await services.status.refresh();
    return statusResponse();
  });

  // ── Role panels (config:rolepanels, same as /rolepanel) ──

  const panelGate = { preHandler: gate(services, 'config:rolepanels') };
  const panelId = (req: FastifyRequest) => parseInput(numericId, req.params).id;
  const panelDto = (p: RolePanel): RolePanelDto => ({
    id: p.id,
    title: p.title,
    description: p.description,
    style: p.style,
    mode: p.mode,
    options: p.options,
    channelId: p.channelId,
    channelName: p.channelId ? (services.guild.getChannel(p.channelId)?.name ?? null) : null,
  });

  api.get(
    '/role-panels',
    panelGate,
    async (): Promise<RolePanelsResponse> => ({
      panels: services.rolePanels.list().map(panelDto),
      roles: services.guild.listRoles().map((r) => ({
        id: r.id,
        name: r.name,
        color: r.color,
        problem: services.rolePanels.roleProblem(r.id),
      })),
    }),
  );

  api.post('/role-panels', panelGate, async (req) =>
    panelDto(services.rolePanels.create(auditActor(req), parseInput(panelInputSchema, req.body))),
  );

  api.patch('/role-panels/:id', panelGate, async (req) => {
    const id = panelId(req);
    const body = parseInput(panelInputSchema, req.body);
    return panelDto(await services.rolePanels.update(auditActor(req), id, body));
  });

  api.delete('/role-panels/:id', panelGate, async (req) => {
    await services.rolePanels.remove(auditActor(req), panelId(req));
    return { ok: true };
  });

  api.post('/role-panels/:id/post', panelGate, async (req) => {
    const id = panelId(req);
    const body = parseInput(z.object({ channelId: snowflake }), req.body);
    return panelDto(await services.rolePanels.post(auditActor(req), id, body.channelId));
  });

  api.post('/role-panels/:id/refresh', panelGate, async (req) =>
    panelDto(await services.rolePanels.refresh(panelId(req))),
  );
}
