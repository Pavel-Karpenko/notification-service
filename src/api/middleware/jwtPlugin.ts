import fp from 'fastify-plugin';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { verifyHS256 } from '../../lib/jwt';

interface JwtPluginOptions {
  secret: string;
}

const jwtPlugin: FastifyPluginAsync<JwtPluginOptions> = async (fastify, opts) => {
  fastify.decorateRequest<{ sub: string } | null>('user', null);
  fastify.decorateRequest('jwtVerify', async function (this: FastifyRequest) {
    const header = this.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw new Error('missing_token');
    const token = header.slice(7);
    const payload = verifyHS256(token, opts.secret);
    this.user = { sub: payload.sub ?? '' };
    return this.user;
  });
};

export default fp(jwtPlugin, { name: 'jwt', fastify: '4.x' });
