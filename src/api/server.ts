import Fastify from 'fastify';
import ajvFormats from 'ajv-formats';
import Redis from 'ioredis';
import { v4 as uuidv4 } from 'uuid';
import { logger } from '../infrastructure/logger';
import { getDb } from '../infrastructure/db/connection';
import { RedisCache } from '../infrastructure/cache/RedisCache';
import { PgUserPreferenceRepository } from '../infrastructure/db/repositories/PgUserPreferenceRepository';
import { PgGlobalPolicyRepository } from '../infrastructure/db/repositories/PgGlobalPolicyRepository';
import { PgDefaultPreferenceRepository } from '../infrastructure/db/repositories/PgDefaultPreferenceRepository';
import { EvaluationService } from '../domain/services/EvaluationService';
import { GetUserPreferences } from '../application/use-cases/GetUserPreferences';
import { UpdateUserPreferences } from '../application/use-cases/UpdateUserPreferences';
import { EvaluateNotification } from '../application/use-cases/EvaluateNotification';
import { registry, httpDuration } from '../infrastructure/metrics/prometheus';
import { getConfig } from '../config';
import jwtPlugin from './middleware/jwtPlugin';
import correlationIdPlugin from './middleware/correlationId';
import swaggerPlugin from './swagger';
import authPlugin from './middleware/auth';
import healthRoutes from './routes/health';
import preferencesRoutes from './routes/preferences';
import evaluateRoutes from './routes/evaluate';

export async function buildServer(redisOverride?: Redis) {
  const config = getConfig();

  const server = Fastify({
    logger,
    genReqId: () => uuidv4(),
    ajv: {
      plugins: [ajvFormats],
    },
  });

  // Infrastructure
  const db = getDb();
  const redis = redisOverride ?? new Redis(config.REDIS_URL);
  const cache = new RedisCache(redis);

  // Repositories
  const userPrefRepo = new PgUserPreferenceRepository(db);
  const globalPolicyRepo = new PgGlobalPolicyRepository(db);
  const defaultPrefRepo = new PgDefaultPreferenceRepository(db);

  // Services
  const evaluationService = new EvaluationService(
    userPrefRepo,
    globalPolicyRepo,
    defaultPrefRepo,
    cache,
  );

  // Use cases
  const getUserPreferences = new GetUserPreferences(userPrefRepo, defaultPrefRepo, cache);
  const updateUserPreferences = new UpdateUserPreferences(userPrefRepo, cache);
  const evaluateNotification = new EvaluateNotification(evaluationService);

  // Plugins — order matters: swagger before routes, JWT before auth hook
  await server.register(swaggerPlugin);
  await server.register(jwtPlugin, { secret: config.JWT_SECRET });
  await server.register(correlationIdPlugin);
  await server.register(authPlugin);

  // HTTP duration metrics hook
  server.addHook('onResponse', (request, reply, done) => {
    const route = request.routerPath ?? request.url;
    httpDuration.observe(
      {
        method: request.method,
        route,
        status_code: String(reply.statusCode),
      },
      reply.elapsedTime / 1000,
    );
    done();
  });

  // Routes
  await server.register(healthRoutes, { redis });
  await server.register(preferencesRoutes, { getUserPreferences, updateUserPreferences });
  await server.register(evaluateRoutes, { evaluateNotification });

  // Prometheus metrics endpoint
  server.get('/metrics', async (_request, reply) => {
    const metrics = await registry.metrics();
    return reply
      .status(200)
      .header('Content-Type', registry.contentType)
      .send(metrics);
  });

  return { server, redis };
}
