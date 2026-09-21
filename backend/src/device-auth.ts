import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

function sameToken(actual: string, expected: string): boolean {
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function acceptsDeviceToken(authorization: string, tokens: string[]): boolean {
  const match = /^Bearer\s+(.+)$/i.exec(authorization);
  if (!match) return false;
  const candidate = match[1]!.trim();
  return candidate.length > 0 && tokens.some((token) => sameToken(candidate, token));
}

/**
 * Browser traffic reaches this process only after Caddy's SSO check and has no
 * Authorization header. Native traffic deliberately bypasses SSO when it has a
 * bearer header, so that header must always be validated here. An invalid token
 * gets a JSON 401 rather than a tinyauth HTML redirect that the app cannot use.
 */
export function registerDeviceAuth(app: FastifyInstance, tokens: string[]): void {
  app.addHook('onRequest', async (request, reply) => {
    const authorization = request.headers.authorization;
    if (!authorization) return;
    if (acceptsDeviceToken(authorization, tokens)) return;
    return reply.code(401).send({ error: 'Device token rejected' });
  });
}
