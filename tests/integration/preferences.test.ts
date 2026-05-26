import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify from 'fastify';
import jwtPlugin from '../../src/api/middleware/jwtPlugin';
import type { Pool } from 'pg';
import { createTestPool, runMigrations, cleanDatabase, createTestDb } from './helpers/setup';
import { NoopCache } from '../../src/infrastructure/cache/RedisCache';
import { PgUserPreferenceRepository } from '../../src/infrastructure/db/repositories/PgUserPreferenceRepository';
import { PgDefaultPreferenceRepository } from '../../src/infrastructure/db/repositories/PgDefaultPreferenceRepository';
import { GetUserPreferences } from '../../src/application/use-cases/GetUserPreferences';
import { UpdateUserPreferences } from '../../src/application/use-cases/UpdateUserPreferences';
import preferencesRoutes from '../../src/api/routes/preferences';
import authPlugin from '../../src/api/middleware/auth';
import { TEST_JWT_SECRET, authHeader } from '../helpers/jwt';

let pool: Pool | null = null;
let server: ReturnType<typeof Fastify> | null = null;

beforeAll(async () => {
  // Set required env for config
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
  const userPrefRepo = new PgUserPreferenceRepository(db);
  const defaultPrefRepo = new PgDefaultPreferenceRepository(db);
  const getUserPreferences = new GetUserPreferences(userPrefRepo, defaultPrefRepo, cache);
  const updateUserPreferences = new UpdateUserPreferences(userPrefRepo, cache);

  server = Fastify({ logger: false });
  await server.register(jwtPlugin, { secret: TEST_JWT_SECRET });
  await server.register(authPlugin);
  await server.register(preferencesRoutes, { getUserPreferences, updateUserPreferences });
  await server.ready();
});

afterAll(async () => {
  if (server) await server.close();
  if (pool) await pool.end();
});

beforeEach(async () => {
  if (pool) await cleanDatabase(pool);
});

// Wraps server.inject with a valid JWT so all integration tests are auth-aware
const req = (opts: { method: string; url: string; payload?: unknown }) =>
  server!.inject({ ...opts, headers: { Authorization: authHeader() } });

describe('GET /users/:userId/preferences', () => {
  it('should skip if no db available', () => {
    if (!pool) {
      console.log('Skipping: no test database');
      return;
    }
  });

  it('should return default preferences for a new user', async () => {
    if (!pool || !server) return;

    const response = await req({
      method: 'GET',
      url: '/users/new-user-123/preferences',
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as {
      userId: string;
      preferences: Array<{ notificationType: string; channel: string; enabled: boolean; source: string }>;
      quietHours: null;
    };
    expect(body.userId).toBe('new-user-123');
    expect(body.quietHours).toBeNull();
    expect(body.preferences).toBeInstanceOf(Array);
    expect(body.preferences.length).toBeGreaterThan(0);

    // All should be from default source
    expect(body.preferences.every((p) => p.source === 'default')).toBe(true);

    // Check known defaults
    const transactionalEmail = body.preferences.find(
      (p) => p.notificationType === 'transactional_email' && p.channel === 'email',
    );
    expect(transactionalEmail?.enabled).toBe(true);

    const marketingEmail = body.preferences.find(
      (p) => p.notificationType === 'marketing_email' && p.channel === 'email',
    );
    expect(marketingEmail?.enabled).toBe(false);
  });

  it('should return user overrides merged with defaults', async () => {
    if (!pool || !server) return;

    // First set a user preference
    const updateResponse = await req({
      method: 'POST',
      url: '/users/user-merge-test/preferences',
      payload: {
        preferences: [
          { notificationType: 'marketing_email', channel: 'email', enabled: true },
        ],
      },
    });
    expect(updateResponse.statusCode).toBe(200);

    // Now get preferences
    const getResponse = await req({
      method: 'GET',
      url: '/users/user-merge-test/preferences',
    });
    expect(getResponse.statusCode).toBe(200);

    const body = JSON.parse(getResponse.body) as {
      preferences: Array<{ notificationType: string; channel: string; enabled: boolean; source: string }>;
    };

    const marketingEmail = body.preferences.find(
      (p) => p.notificationType === 'marketing_email' && p.channel === 'email',
    );
    expect(marketingEmail?.enabled).toBe(true);
    expect(marketingEmail?.source).toBe('user');
  });
});

describe('POST /users/:userId/preferences', () => {
  it('should update user preferences', async () => {
    if (!pool || !server) return;

    const response = await req({
      method: 'POST',
      url: '/users/user-update-test/preferences',
      payload: {
        preferences: [
          { notificationType: 'marketing_email', channel: 'email', enabled: false },
          { notificationType: 'transactional_email', channel: 'email', enabled: true },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as { userId: string; updatedCount: number };
    expect(body.userId).toBe('user-update-test');
    expect(body.updatedCount).toBe(2);
  });

  it('should set and return quiet hours', async () => {
    if (!pool || !server) return;

    const response = await req({
      method: 'POST',
      url: '/users/user-qh-test/preferences',
      payload: {
        quietHours: {
          startHour: 22,
          startMinute: 0,
          endHour: 8,
          endMinute: 0,
          timezone: 'Europe/Berlin',
        },
      },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as {
      quietHours: { startHour: number; endHour: number; timezone: string } | null;
    };
    expect(body.quietHours).toBeTruthy();
    expect(body.quietHours?.startHour).toBe(22);
    expect(body.quietHours?.endHour).toBe(8);
    expect(body.quietHours?.timezone).toBe('Europe/Berlin');
  });

  it('should be idempotent — double upsert yields same result', async () => {
    if (!pool || !server) return;

    const payload = {
      preferences: [
        { notificationType: 'marketing_email', channel: 'email', enabled: false },
      ],
    };

    const r1 = await req({
      method: 'POST',
      url: '/users/user-idempotent/preferences',
      payload,
    });
    const r2 = await req({
      method: 'POST',
      url: '/users/user-idempotent/preferences',
      payload,
    });

    expect(r1.statusCode).toBe(200);
    expect(r2.statusCode).toBe(200);

    const getResponse = await req({
      method: 'GET',
      url: '/users/user-idempotent/preferences',
    });
    const body = JSON.parse(getResponse.body) as {
      preferences: Array<{ notificationType: string; channel: string; enabled: boolean; source: string }>;
    };

    const marketingEmail = body.preferences.find(
      (p) => p.notificationType === 'marketing_email' && p.channel === 'email',
    );
    expect(marketingEmail?.enabled).toBe(false);
    expect(marketingEmail?.source).toBe('user');
  });

  it('should return 400 for invalid notification type', async () => {
    if (!pool || !server) return;

    const response = await req({
      method: 'POST',
      url: '/users/user-invalid/preferences',
      payload: {
        preferences: [
          { notificationType: 'invalid_type', channel: 'email', enabled: false },
        ],
      },
    });

    expect(response.statusCode).toBe(400);
  });

  it('should return 400 for invalid timezone in quiet hours', async () => {
    if (!pool || !server) return;

    const response = await req({
      method: 'POST',
      url: '/users/user-invalid-qh/preferences',
      payload: {
        quietHours: {
          startHour: 25, // invalid
          startMinute: 0,
          endHour: 8,
          endMinute: 0,
          timezone: 'Europe/Berlin',
        },
      },
    });

    expect(response.statusCode).toBe(400);
  });
});
