import { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';

const PUBLIC_PATHS = new Set(['/healthz', '/readyz', '/metrics']);
const PUBLIC_PREFIXES = ['/docs'];

const authPlugin: FastifyPluginAsync = async (fastify) => {
  fastify.addHook('onRequest', async (request, reply) => {
    const path = request.routerPath ?? request.url.split('?')[0];

    if (PUBLIC_PATHS.has(path)) return;
    if (PUBLIC_PREFIXES.some(prefix => path === prefix || path.startsWith(prefix + '/'))) return;

    try {
      await request.jwtVerify();
    } catch {
      return reply.status(401).send({
        error: 'Unauthorized',
        message: 'Valid Bearer token required',
      });
    }
  });
};

export default fp(authPlugin, { name: 'auth' });
