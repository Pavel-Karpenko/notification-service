import type { FastifyPluginAsync } from 'fastify';
import { checkDbConnection } from '../../infrastructure/db/connection';
import type Redis from 'ioredis';

interface HealthRouteOptions {
  redis: Redis;
}

const statusSchema = {
  type: 'object',
  required: ['status'],
  properties: {
    status: { type: 'string', enum: ['ok', 'degraded'] },
    db: { type: 'string', enum: ['ok', 'error'] },
    redis: { type: 'string', enum: ['ok', 'error'] },
  },
} as const;

const healthRoutes: FastifyPluginAsync<HealthRouteOptions> = async (fastify, opts) => {
  fastify.get(
    '/healthz',
    {
      schema: {
        tags: ['System'],
        summary: 'Liveness probe',
        description: 'Returns 200 as long as the process is running. Does not check dependencies.',
        response: {
          200: { ...statusSchema, description: 'Process is alive' },
        },
      },
    },
    async (_request, reply) => {
      return reply.status(200).send({ status: 'ok' });
    },
  );

  fastify.get(
    '/readyz',
    {
      schema: {
        tags: ['System'],
        summary: 'Readiness probe',
        description: 'Checks connectivity to PostgreSQL and Redis. Returns 503 if either is unavailable.',
        response: {
          200: { ...statusSchema, description: 'All dependencies healthy' },
          503: { ...statusSchema, description: 'One or more dependencies unavailable' },
        },
      },
    },
    async (_request, reply) => {
      const [dbOk, redisOk] = await Promise.all([
        checkDbConnection(),
        checkRedis(opts.redis),
      ]);

      if (dbOk && redisOk) {
        return reply.status(200).send({ status: 'ok', db: 'ok', redis: 'ok' });
      }

      return reply.status(503).send({
        status: 'degraded',
        db: dbOk ? 'ok' : 'error',
        redis: redisOk ? 'ok' : 'error',
      });
    },
  );
};

async function checkRedis(redis: Redis): Promise<boolean> {
  try {
    await redis.ping();
    return true;
  } catch {
    return false;
  }
}

export default healthRoutes;
