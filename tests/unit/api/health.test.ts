/**
 * Health endpoint tests — uses mocked DB and Redis, no real infrastructure.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';

vi.mock('../../../src/infrastructure/db/connection', () => ({
  checkDbConnection: vi.fn().mockResolvedValue(true),
  getDb: vi.fn(),
  closeDb: vi.fn(),
}));

vi.mock('../../../src/infrastructure/metrics/prometheus', () => ({
  registry: {
    metrics: vi.fn().mockResolvedValue('# HELP notifications_evaluated_total Total notification evaluations\n'),
    contentType: 'text/plain; version=0.0.4; charset=utf-8',
  },
  evaluationsTotal: { inc: vi.fn() },
  preferenceUpdatesTotal: { inc: vi.fn() },
  httpDuration: { observe: vi.fn() },
  cacheHitsTotal: { inc: vi.fn() },
  cacheMissesTotal: { inc: vi.fn() },
  collectDefaultMetrics: vi.fn(),
}));

import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import jwtPlugin from '../../../src/api/middleware/jwtPlugin';
import healthRoutes from '../../../src/api/routes/health';
import authPlugin from '../../../src/api/middleware/auth';
import * as dbConnection from '../../../src/infrastructure/db/connection';
import type Redis from 'ioredis';
import { TEST_JWT_SECRET } from '../../helpers/jwt';

const mockRedis = {
  ping: vi.fn().mockResolvedValue('PONG'),
} as unknown as Redis;

let server: FastifyInstance;

beforeAll(async () => {
  server = Fastify({ logger: false });
  await server.register(jwtPlugin, { secret: TEST_JWT_SECRET });
  await server.register(authPlugin);
  await server.register(healthRoutes, { redis: mockRedis });
  await server.ready();
});

afterAll(async () => {
  await server.close();
});

// Reset mocks before each test to prevent queue bleed between tests
beforeEach(() => {
  vi.mocked(dbConnection.checkDbConnection).mockReset().mockResolvedValue(true);
  vi.mocked(mockRedis.ping as (...args: unknown[]) => unknown).mockReset().mockResolvedValue('PONG');
});

describe('GET /healthz', () => {
  it('returns 200 with status ok', async () => {
    const res = await server.inject({ method: 'GET', url: '/healthz' });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { status: string };
    expect(body.status).toBe('ok');
  });

  it('returns ok regardless of DB/Redis state (liveness only checks process is alive)', async () => {
    // /healthz is a liveness probe — it does NOT check DB or Redis
    // It always returns 200 as long as the process is running
    const res = await server.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
  });
});

describe('GET /readyz', () => {
  it('returns 200 when both DB and Redis are healthy', async () => {
    (dbConnection.checkDbConnection as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    (mockRedis.ping as ReturnType<typeof vi.fn>).mockResolvedValue('PONG');

    const res = await server.inject({ method: 'GET', url: '/readyz' });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { status: string; db: string; redis: string };
    expect(body.status).toBe('ok');
    expect(body.db).toBe('ok');
    expect(body.redis).toBe('ok');
  });

  it('returns 503 when DB is unavailable', async () => {
    (dbConnection.checkDbConnection as ReturnType<typeof vi.fn>).mockResolvedValueOnce(false);
    (mockRedis.ping as ReturnType<typeof vi.fn>).mockResolvedValue('PONG');

    const res = await server.inject({ method: 'GET', url: '/readyz' });

    expect(res.statusCode).toBe(503);
    const body = JSON.parse(res.body) as { status: string; db: string; redis: string };
    expect(body.status).toBe('degraded');
    expect(body.db).toBe('error');
    expect(body.redis).toBe('ok');
  });

  it('returns 503 when Redis is unavailable', async () => {
    (dbConnection.checkDbConnection as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    (mockRedis.ping as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('Connection refused'));

    const res = await server.inject({ method: 'GET', url: '/readyz' });

    expect(res.statusCode).toBe(503);
    const body = JSON.parse(res.body) as { status: string; db: string; redis: string };
    expect(body.status).toBe('degraded');
    expect(body.db).toBe('ok');
    expect(body.redis).toBe('error');
  });

  it('returns 503 when both DB and Redis are unavailable', async () => {
    (dbConnection.checkDbConnection as ReturnType<typeof vi.fn>).mockResolvedValueOnce(false);
    (mockRedis.ping as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('Connection refused'));

    const res = await server.inject({ method: 'GET', url: '/readyz' });

    expect(res.statusCode).toBe(503);
    const body = JSON.parse(res.body) as { status: string; db: string; redis: string };
    expect(body.status).toBe('degraded');
    expect(body.db).toBe('error');
    expect(body.redis).toBe('error');
  });
});
