// Module augmentation — adds jwtVerify and user to FastifyRequest globally.
// The import type makes this a module so declare module is augmentation, not replacement.
import type {} from 'fastify';

declare module 'fastify' {
  interface FastifyRequest {
    jwtVerify(): Promise<{ sub: string }>;
    user: { sub: string };
  }
}
