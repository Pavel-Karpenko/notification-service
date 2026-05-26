import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify from 'fastify';
import jwtPlugin from '../../src/api/middleware/jwtPlugin';
import type { Pool } from 'pg';
import { createTestPool, runMigrations, cleanDatabase, createTestDb } from './helpers/setup';
import { NoopCache } from '../../src/infrastructure/cache/RedisCache';
import { PgUserPreferenceRepository } from '../../src/infrastructure/db/repositories/PgUserPreferenceRepository';
import { PgGlobalPolicyRepository } from '../../src/infrastructure/db/repositories/PgGlobalPolicyRepository';
import { PgDefaultPreferenceRepository } from '../../src/infrastructure/db/repositories/PgDefaultPreferenceRepository';
import { EvaluationService } from '../../src/domain/services/EvaluationService';
import { EvaluateNotification } from '../../src/application/use-cases/EvaluateNotification';
import evaluateRoutes from '../../src/api/routes/evaluate';
import authPlugin from '../../src/api/middleware/auth';
import { TEST_JWT_SECRET, authHeader } from '../helpers/jwt';

let pool: Pool | null = null;
let server: ReturnType<typeof Fastify> | null = null;
let globalPolicyRepo: PgGlobalPolicyRepository | null = null;
let userPrefRepo: PgUserPreferenceRepository | null = null;

beforeAll(async () => {
  process.env['DATABASE_URL'] = process.env['TEST_DATABASE_URL'] ?? 'postgresql://postgres:postgres@localhost:5432/notifications_test';
  process.env['REDIS_URL'] = 'redis://localhost:6379';
  process.env['JWT_SECRET'] = TEST_JWT_SECRET;

  pool = await createTestPool();
  if (!pool) {
    console.warn('Skipping integration tests: no test database available');
    return;
  }

  await runMigrations(pool);

  const db = createTestDb(pool);
  const cache = new NoopCache();
  userPrefRepo = new PgUserPreferenceRepository(db);
  globalPolicyRepo = new PgGlobalPolicyRepository(db);
  const defaultPrefRepo = new PgDefaultPreferenceRepository(db);
  const evaluationService = new EvaluationService(userPrefRepo, globalPolicyRepo, defaultPrefRepo, cache);
  const evaluateNotification = new EvaluateNotification(evaluationService);

  server = Fastify({ logger: false });
  await server.register(jwtPlugin, { secret: TEST_JWT_SECRET });
  await server.register(authPlugin);
  await server.register(evaluateRoutes, { evaluateNotification });
  await server.ready();
});

afterAll(async () => {
  if (server) await server.close();
  if (pool) await pool.end();
});

beforeEach(async () => {
  if (pool) await cleanDatabase(pool);
});

const EVAL_PATH = '/evaluate';
const req = (opts: { method: string; url: string; payload?: unknown }) =>
  server!.inject({ ...opts, headers: { Authorization: authHeader() } });

describe('POST /evaluate', () => {
  it('should allow transactional_email for new user (default enabled)', async () => {
    if (!pool || !server) return;

    const response = await req({
      method: 'POST',
      url: EVAL_PATH,
      payload: {
        userId: 'eval-user-1',
        notificationType: 'transactional_email',
        channel: 'email',
        region: 'EU',
        datetime: '2026-05-21T10:00:00Z',
      },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as { decision: string; reason: string };
    expect(body.decision).toBe('allow');
    expect(body.reason).toBe('default_preference');
  });

  it('should deny marketing_email for new user (default disabled)', async () => {
    if (!pool || !server) return;

    const response = await req({
      method: 'POST',
      url: EVAL_PATH,
      payload: {
        userId: 'eval-user-2',
        notificationType: 'marketing_email',
        channel: 'email',
        region: 'EU',
        datetime: '2026-05-21T10:00:00Z',
      },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as { decision: string; reason: string };
    expect(body.decision).toBe('deny');
    expect(body.reason).toBe('default_preference');
  });

  it('should deny when global policy blocks marketing_sms in EU', async () => {
    if (!pool || !server || !globalPolicyRepo) return;

    await globalPolicyRepo.upsert({
      notificationType: 'marketing_sms',
      channel: 'sms',
      region: 'EU',
      action: 'deny',
    });

    const response = await req({
      method: 'POST',
      url: EVAL_PATH,
      payload: {
        userId: 'eval-user-3',
        notificationType: 'marketing_sms',
        channel: 'sms',
        region: 'EU',
        datetime: '2026-05-21T10:00:00Z',
      },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as { decision: string; reason: string };
    expect(body.decision).toBe('deny');
    expect(body.reason).toBe('blocked_by_global_policy');
  });

  it('should deny when user explicitly disabled', async () => {
    if (!pool || !server || !userPrefRepo) return;

    await userPrefRepo.upsert({
      userId: 'eval-user-4',
      notificationType: 'transactional_email',
      channel: 'email',
      enabled: false,
    });

    const response = await req({
      method: 'POST',
      url: EVAL_PATH,
      payload: {
        userId: 'eval-user-4',
        notificationType: 'transactional_email',
        channel: 'email',
        region: 'US',
        datetime: '2026-05-21T10:00:00Z',
      },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as { decision: string; reason: string };
    expect(body.decision).toBe('deny');
    expect(body.reason).toBe('disabled_by_user');
  });

  it('should deny marketing during quiet hours', async () => {
    if (!pool || !server || !userPrefRepo) return;

    await userPrefRepo.upsertQuietHours({
      userId: 'eval-user-5',
      startHour: 22,
      startMinute: 0,
      endHour: 8,
      endMinute: 0,
      timezone: 'UTC',
    });

    const response = await req({
      method: 'POST',
      url: EVAL_PATH,
      payload: {
        userId: 'eval-user-5',
        notificationType: 'marketing_push',
        channel: 'push',
        region: 'US',
        datetime: '2026-05-21T23:00:00Z', // 23:00 UTC — in quiet hours
      },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as { decision: string; reason: string };
    expect(body.decision).toBe('deny');
    expect(body.reason).toBe('quiet_hours');
  });

  it('should allow transactional during quiet hours (bypass)', async () => {
    if (!pool || !server || !userPrefRepo) return;

    await userPrefRepo.upsertQuietHours({
      userId: 'eval-user-6',
      startHour: 22,
      startMinute: 0,
      endHour: 8,
      endMinute: 0,
      timezone: 'UTC',
    });

    const response = await req({
      method: 'POST',
      url: EVAL_PATH,
      payload: {
        userId: 'eval-user-6',
        notificationType: 'transactional_push',
        channel: 'push',
        region: 'US',
        datetime: '2026-05-21T23:00:00Z', // 23:00 UTC — in quiet hours
      },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as { decision: string; reason: string };
    expect(body.decision).toBe('allow');
    // transactional_push default is enabled
    expect(body.reason).toBe('default_preference');
  });

  it('should return 400 for invalid request body', async () => {
    if (!pool || !server) return;

    const response = await req({
      method: 'POST',
      url: EVAL_PATH,
      payload: {
        userId: 'eval-user-7',
        notificationType: 'unknown_type',
        channel: 'email',
        region: 'EU',
        datetime: '2026-05-21T10:00:00Z',
      },
    });

    expect(response.statusCode).toBe(400);
  });

  it('should return 400 for invalid datetime', async () => {
    if (!pool || !server) return;

    const response = await req({
      method: 'POST',
      url: EVAL_PATH,
      payload: {
        userId: 'eval-user-8',
        notificationType: 'marketing_email',
        channel: 'email',
        region: 'EU',
        datetime: 'not-a-date',
      },
    });

    expect(response.statusCode).toBe(400);
  });
});
