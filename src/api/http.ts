import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import type { z } from 'zod';
import { describeDiscordError } from '../discord/errors.js';
import type { Logger } from '../logger.js';
import type { Actor } from '../services/commands/types.js';
import type { Services } from '../services/container.js';
import { isUserError, PermissionDeniedError } from '../services/errors.js';
import type { SessionRow } from '../services/sessions.js';
import type { ApiError } from '../shared/api.js';

declare module 'fastify' {
  interface FastifyRequest {
    actor: Actor | null;
    session: SessionRow | null;
  }
}

/** An error with an HTTP status and a message safe to show the user. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly node?: string,
  ) {
    super(message);
  }
}

/** Validate input with zod, turning problems into a readable 400. */
export function parseInput<T>(schema: z.ZodType<T>, data: unknown): T {
  const r = schema.safeParse(data ?? {});
  if (!r.success) {
    const msg = r.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ');
    throw new HttpError(400, `Invalid input: ${msg}`);
  }
  return r.data;
}

export function requireActor(req: FastifyRequest): Actor {
  if (!req.actor) throw new HttpError(401, 'Not logged in.');
  return req.actor;
}

/** preHandler that checks a permission node with the same resolver as slash commands. */
export function gate(services: Services, node: string) {
  return async (req: FastifyRequest) => {
    const actor = requireActor(req);
    if (!services.permissions.check(actor, node).allowed) {
      throw new HttpError(403, `You don't have permission (${node}).`, node);
    }
  };
}

export function errorHandler(logger: Logger) {
  return (err: FastifyError | Error, req: FastifyRequest, reply: FastifyReply) => {
    const send = (status: number, body: ApiError) => reply.code(status).send(body);
    if (err instanceof HttpError)
      return send(err.status, { error: err.message, ...(err.node ? { node: err.node } : {}) });
    if (err instanceof PermissionDeniedError) return send(403, { error: err.message, node: err.node });
    if (isUserError(err)) return send(400, { error: err.message });
    const discord = describeDiscordError(err);
    if (discord) return send(502, { error: discord });
    const status = (err as FastifyError).statusCode;
    if (status && status >= 400 && status < 500) return send(status, { error: (err as Error).message });
    logger.error({ err, url: req.url, method: req.method }, 'API request failed');
    return send(500, { error: 'Something went wrong. The error has been logged.' });
  };
}
