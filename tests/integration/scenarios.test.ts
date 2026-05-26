/**
 * End-to-end integration tests covering all 5 scenarios from the ТЗ.
 *
 * Requires a running PostgreSQL database. Set TEST_DATABASE_URL to point to it.
 * Tests skip gracefully when the database is unavailable.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { createTestPool, runMigrations, cleanDatabase, createTestDb } from './helpers/setup';
import { NoopCache } from '../../src/infrastructure/cache/RedisCache';
import { PgUserPreferenceRepository } from '../../src/infrastructure/db/repositories/PgUserPreferenceRepository';
import { PgGlobalPolicyRepository } from '../../src/infrastructure/db/repositories/PgGlobalPolicyRepository';
import { PgDefaultPreferenceRepository } from '../../src/infrastructure/db/repositories/PgDefaultPreferenceRepository';
import { EvaluationService } from '../../src/domain/services/EvaluationService';
import { GetUserPreferences } from '../../src/application/use-cases/GetUserPreferences';
import { UpdateUserPreferences } from '../../src/application/use-cases/UpdateUserPreferences';
import { EvaluateNotification } from '../../src/application/use-cases/EvaluateNotification';
import jwtPlugin from '../../src/api/middleware/jwtPlugin';
import preferencesRoutes from '../../src/api/routes/preferences';
import evaluateRoutes from '../../src/api/routes/evaluate';
import authPlugin from '../../src/api/middleware/auth';
import { TEST_JWT_SECRET, authHeader } from '../helpers/jwt';

// ─── Setup ─────────────────────────────────────────────────────────────────

let pool: Pool | null = null;
let server: FastifyInstance | null = null;
let globalPolicyRepo: PgGlobalPolicyRepository | null = null;
let userPrefRepo: PgUserPreferenceRepository | null = null;

const DB_URL =
  process.env['TEST_DATABASE_URL'] ??
  'postgresql://postgres:postgres@localhost:5432/notifications_test';

beforeAll(async () => {
  process.env['DATABASE_URL'] = DB_URL;
  process.env['REDIS_URL'] = 'redis://localhost:6379';
  process.env['JWT_SECRET'] = TEST_JWT_SECRET;

  pool = await createTestPool();
  if (!pool) {
    console.warn('⚠️  Skipping integration scenarios: no test database available');
    return;
  }

  await runMigrations(pool);

  const db = createTestDb(pool);
  const cache = new NoopCache();

  userPrefRepo = new PgUserPreferenceRepository(db);
  globalPolicyRepo = new PgGlobalPolicyRepository(db);
  const defaultPrefRepo = new PgDefaultPreferenceRepository(db);

  const evaluationService = new EvaluationService(
    userPrefRepo,
    globalPolicyRepo,
    defaultPrefRepo,
    cache,
  );

  const getUserPreferences = new GetUserPreferences(userPrefRepo, defaultPrefRepo, cache);
  const updateUserPreferences = new UpdateUserPreferences(userPrefRepo, cache);
  const evaluateNotification = new EvaluateNotification(evaluationService);

  server = Fastify({ logger: false });
  await server.register(jwtPlugin, { secret: TEST_JWT_SECRET });
  await server.register(authPlugin);
  await server.register(preferencesRoutes, { getUserPreferences, updateUserPreferences });
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

// All scenario requests carry a valid JWT token
const req = (opts: { method: string; url: string; payload?: unknown }) =>
  server!.inject({ ...opts, headers: { Authorization: authHeader() } });

// ─── Helper types ──────────────────────────────────────────────────────────

interface PreferenceItem {
  notificationType: string;
  channel: string;
  enabled: boolean;
  source: 'user' | 'default';
}

interface GetPrefsResponse {
  userId: string;
  preferences: PreferenceItem[];
  quietHours: {
    startHour: number;
    startMinute: number;
    endHour: number;
    endMinute: number;
    timezone: string;
  } | null;
}

interface EvalResponse {
  decision: 'allow' | 'deny';
  reason: string;
}

// ─── ТЗ Сценарий 1: Новый пользователь и дефолты ─────────────────────────

describe('ТЗ Сценарий 1: Новый пользователь получает дефолтные настройки', () => {
  it('GET /preferences returns default prefs for a brand new user', async () => {
    if (!pool || !server) return;

    const res = await req({ method: 'GET', url: '/users/brand-new-user/preferences' });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as GetPrefsResponse;
    expect(body.userId).toBe('brand-new-user');
    expect(body.preferences.length).toBeGreaterThan(0);
    expect(body.preferences.every((p) => p.source === 'default')).toBe(true);
    expect(body.quietHours).toBeNull();
  });

  it('transactional_email is enabled by default', async () => {
    if (!pool || !server) return;

    const res = await req({ method: 'GET', url: '/users/new-user/preferences' });
    const body = JSON.parse(res.body) as GetPrefsResponse;

    const pref = body.preferences.find(
      (p) => p.notificationType === 'transactional_email' && p.channel === 'email',
    );
    expect(pref?.enabled).toBe(true);
    expect(pref?.source).toBe('default');
  });

  it('marketing_email is disabled by default', async () => {
    if (!pool || !server) return;

    const res = await req({ method: 'GET', url: '/users/new-user/preferences' });
    const body = JSON.parse(res.body) as GetPrefsResponse;

    const pref = body.preferences.find(
      (p) => p.notificationType === 'marketing_email' && p.channel === 'email',
    );
    expect(pref?.enabled).toBe(false);
    expect(pref?.source).toBe('default');
  });

  it('evaluate allows transactional_email for new user', async () => {
    if (!pool || !server) return;

    const res = await req({
      method: 'POST',
      url: '/evaluate',
      payload: {
        userId: 'new-user',
        notificationType: 'transactional_email',
        channel: 'email',
        region: 'EU',
        datetime: '2026-05-21T10:00:00Z',
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as EvalResponse;
    expect(body.decision).toBe('allow');
    expect(body.reason).toBe('default_preference');
  });

  it('evaluate denies marketing_email for new user', async () => {
    if (!pool || !server) return;

    const res = await req({
      method: 'POST',
      url: '/evaluate',
      payload: {
        userId: 'new-user',
        notificationType: 'marketing_email',
        channel: 'email',
        region: 'EU',
        datetime: '2026-05-21T10:00:00Z',
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as EvalResponse;
    expect(body.decision).toBe('deny');
    expect(body.reason).toBe('default_preference');
  });

  it('all 6 default type+channel combos are returned', async () => {
    if (!pool || !server) return;

    const res = await req({ method: 'GET', url: '/users/new-user/preferences' });
    const body = JSON.parse(res.body) as GetPrefsResponse;

    const expectedCombos = [
      { notificationType: 'transactional_email', channel: 'email' },
      { notificationType: 'marketing_email', channel: 'email' },
      { notificationType: 'transactional_sms', channel: 'sms' },
      { notificationType: 'marketing_sms', channel: 'sms' },
      { notificationType: 'transactional_push', channel: 'push' },
      { notificationType: 'marketing_push', channel: 'push' },
    ];

    for (const combo of expectedCombos) {
      expect(
        body.preferences.some(
          (p) => p.notificationType === combo.notificationType && p.channel === combo.channel,
        ),
      ).toBe(true);
    }
  });
});

// ─── ТЗ Сценарий 2: Изменение настроек пользователем ─────────────────────

describe('ТЗ Сценарий 2: Пользователь меняет настройки', () => {
  it('user disables marketing_email and evaluate reflects it', async () => {
    if (!pool || !server) return;

    // Step 1: disable marketing_email
    await req({
      method: 'POST',
      url: '/users/user-2a/preferences',
      payload: {
        preferences: [{ notificationType: 'marketing_email', channel: 'email', enabled: false }],
      },
    });

    // Step 2: evaluate → should deny
    const evalRes = await req({
      method: 'POST',
      url: '/evaluate',
      payload: {
        userId: 'user-2a',
        notificationType: 'marketing_email',
        channel: 'email',
        region: 'US',
        datetime: '2026-05-21T10:00:00Z',
      },
    });

    const body = JSON.parse(evalRes.body) as EvalResponse;
    expect(body.decision).toBe('deny');
    expect(body.reason).toBe('disabled_by_user');
  });

  it('disabling marketing_email does not affect transactional_email', async () => {
    if (!pool || !server) return;

    await req({
      method: 'POST',
      url: '/users/user-2b/preferences',
      payload: {
        preferences: [{ notificationType: 'marketing_email', channel: 'email', enabled: false }],
      },
    });

    const evalRes = await req({
      method: 'POST',
      url: '/evaluate',
      payload: {
        userId: 'user-2b',
        notificationType: 'transactional_email',
        channel: 'email',
        region: 'US',
        datetime: '2026-05-21T10:00:00Z',
      },
    });

    const body = JSON.parse(evalRes.body) as EvalResponse;
    expect(body.decision).toBe('allow');
  });

  it('GET preferences reflects user override with source="user"', async () => {
    if (!pool || !server) return;

    await req({
      method: 'POST',
      url: '/users/user-2c/preferences',
      payload: {
        preferences: [{ notificationType: 'marketing_email', channel: 'email', enabled: true }],
      },
    });

    const getRes = await req({
      method: 'GET',
      url: '/users/user-2c/preferences',
    });

    const body = JSON.parse(getRes.body) as GetPrefsResponse;
    const marketingEmail = body.preferences.find(
      (p) => p.notificationType === 'marketing_email' && p.channel === 'email',
    );
    expect(marketingEmail?.enabled).toBe(true);
    expect(marketingEmail?.source).toBe('user');
  });

  it('user can re-enable a previously disabled notification', async () => {
    if (!pool || !server) return;

    // Disable
    await req({
      method: 'POST',
      url: '/users/user-2d/preferences',
      payload: { preferences: [{ notificationType: 'marketing_email', channel: 'email', enabled: false }] },
    });

    // Re-enable
    await req({
      method: 'POST',
      url: '/users/user-2d/preferences',
      payload: { preferences: [{ notificationType: 'marketing_email', channel: 'email', enabled: true }] },
    });

    const evalRes = await req({
      method: 'POST',
      url: '/evaluate',
      payload: {
        userId: 'user-2d',
        notificationType: 'marketing_email',
        channel: 'email',
        region: 'US',
        datetime: '2026-05-21T10:00:00Z',
      },
    });

    const body = JSON.parse(evalRes.body) as EvalResponse;
    expect(body.decision).toBe('allow');
    expect(body.reason).toBe('user_preference');
  });
});

// ─── ТЗ Сценарий 3: Quiet hours ───────────────────────────────────────────

describe('ТЗ Сценарий 3: Quiet hours', () => {
  const QUIET_HOURS = {
    startHour: 22,
    startMinute: 0,
    endHour: 8,
    endMinute: 0,
    timezone: 'UTC',
  };

  it('marketing_push is blocked during quiet hours', async () => {
    if (!pool || !server) return;

    await req({
      method: 'POST',
      url: '/users/user-3a/preferences',
      payload: { quietHours: QUIET_HOURS },
    });

    const evalRes = await req({
      method: 'POST',
      url: '/evaluate',
      payload: {
        userId: 'user-3a',
        notificationType: 'marketing_push',
        channel: 'push',
        region: 'US',
        datetime: '2026-05-21T23:00:00Z', // 23:00 UTC — in quiet hours
      },
    });

    const body = JSON.parse(evalRes.body) as EvalResponse;
    expect(body.decision).toBe('deny');
    expect(body.reason).toBe('quiet_hours');
  });

  it('marketing_push is allowed outside quiet hours', async () => {
    if (!pool || !server) return;

    await req({
      method: 'POST',
      url: '/users/user-3b/preferences',
      payload: {
        preferences: [{ notificationType: 'marketing_push', channel: 'push', enabled: true }],
        quietHours: QUIET_HOURS,
      },
    });

    const evalRes = await req({
      method: 'POST',
      url: '/evaluate',
      payload: {
        userId: 'user-3b',
        notificationType: 'marketing_push',
        channel: 'push',
        region: 'US',
        datetime: '2026-05-21T12:00:00Z', // 12:00 UTC — outside quiet hours
      },
    });

    const body = JSON.parse(evalRes.body) as EvalResponse;
    expect(body.decision).toBe('allow');
  });

  it('transactional_push is NOT blocked by quiet hours', async () => {
    if (!pool || !server) return;

    await req({
      method: 'POST',
      url: '/users/user-3c/preferences',
      payload: { quietHours: QUIET_HOURS },
    });

    const evalRes = await req({
      method: 'POST',
      url: '/evaluate',
      payload: {
        userId: 'user-3c',
        notificationType: 'transactional_push',
        channel: 'push',
        region: 'US',
        datetime: '2026-05-21T23:30:00Z', // deep in quiet hours
      },
    });

    const body = JSON.parse(evalRes.body) as EvalResponse;
    expect(body.decision).toBe('allow');
    expect(body.reason).not.toBe('quiet_hours');
  });

  it('transactional_email is NOT blocked by quiet hours', async () => {
    if (!pool || !server) return;

    await req({
      method: 'POST',
      url: '/users/user-3d/preferences',
      payload: { quietHours: QUIET_HOURS },
    });

    const evalRes = await req({
      method: 'POST',
      url: '/evaluate',
      payload: {
        userId: 'user-3d',
        notificationType: 'transactional_email',
        channel: 'email',
        region: 'US',
        datetime: '2026-05-21T02:00:00Z', // 02:00 UTC — in quiet hours
      },
    });

    const body = JSON.parse(evalRes.body) as EvalResponse;
    expect(body.decision).toBe('allow');
  });

  it('quiet hours with non-UTC timezone are handled correctly', async () => {
    if (!pool || !server) return;

    // quiet hours 22:00-08:00 in Europe/Berlin (UTC+2 in summer)
    // 20:30 UTC = 22:30 Berlin → inside quiet hours
    await req({
      method: 'POST',
      url: '/users/user-3e/preferences',
      payload: {
        quietHours: { startHour: 22, startMinute: 0, endHour: 8, endMinute: 0, timezone: 'Europe/Berlin' },
      },
    });

    const evalRes = await req({
      method: 'POST',
      url: '/evaluate',
      payload: {
        userId: 'user-3e',
        notificationType: 'marketing_email',
        channel: 'email',
        region: 'EU',
        datetime: '2026-05-21T20:30:00Z', // 22:30 Berlin time
      },
    });

    const body = JSON.parse(evalRes.body) as EvalResponse;
    expect(body.decision).toBe('deny');
    expect(body.reason).toBe('quiet_hours');
  });

  it('quiet hours saved and returned in GET preferences', async () => {
    if (!pool || !server) return;

    await req({
      method: 'POST',
      url: '/users/user-3f/preferences',
      payload: { quietHours: { startHour: 22, startMinute: 30, endHour: 7, endMinute: 45, timezone: 'America/New_York' } },
    });

    const getRes = await req({ method: 'GET', url: '/users/user-3f/preferences' });
    const body = JSON.parse(getRes.body) as GetPrefsResponse;

    expect(body.quietHours).toMatchObject({
      startHour: 22,
      startMinute: 30,
      endHour: 7,
      endMinute: 45,
      timezone: 'America/New_York',
    });
  });
});

// ─── ТЗ Сценарий 4: Глобальные политики ──────────────────────────────────

describe('ТЗ Сценарий 4: Глобальные политики', () => {
  it('blocks marketing_sms in EU when global policy exists', async () => {
    if (!pool || !server || !globalPolicyRepo) return;

    await globalPolicyRepo.upsert({
      notificationType: 'marketing_sms',
      channel: 'sms',
      region: 'EU',
      action: 'deny',
    });

    const evalRes = await req({
      method: 'POST',
      url: '/evaluate',
      payload: {
        userId: 'user-4a',
        notificationType: 'marketing_sms',
        channel: 'sms',
        region: 'EU',
        datetime: '2026-05-21T10:00:00Z',
      },
    });

    const body = JSON.parse(evalRes.body) as EvalResponse;
    expect(body.decision).toBe('deny');
    expect(body.reason).toBe('blocked_by_global_policy');
  });

  it('same type in different region is NOT blocked by EU policy', async () => {
    if (!pool || !server || !globalPolicyRepo) return;

    await globalPolicyRepo.upsert({
      notificationType: 'marketing_sms',
      channel: 'sms',
      region: 'EU',
      action: 'deny',
    });

    // Enable marketing_sms by default isn't seeded, so enable it via user pref
    await userPrefRepo!.upsert({
      userId: 'user-4b',
      notificationType: 'marketing_sms',
      channel: 'sms',
      enabled: true,
    });

    const evalRes = await req({
      method: 'POST',
      url: '/evaluate',
      payload: {
        userId: 'user-4b',
        notificationType: 'marketing_sms',
        channel: 'sms',
        region: 'US', // different region
        datetime: '2026-05-21T10:00:00Z',
      },
    });

    const body = JSON.parse(evalRes.body) as EvalResponse;
    expect(body.decision).toBe('allow');
    expect(body.reason).toBe('user_preference');
  });

  it('global policy overrides even user-enabled preference', async () => {
    if (!pool || !server || !globalPolicyRepo) return;

    await globalPolicyRepo.upsert({
      notificationType: 'marketing_email',
      channel: 'email',
      region: 'EU',
      action: 'deny',
    });

    // User explicitly enabled marketing_email
    await req({
      method: 'POST',
      url: '/users/user-4c/preferences',
      payload: {
        preferences: [{ notificationType: 'marketing_email', channel: 'email', enabled: true }],
      },
    });

    const evalRes = await req({
      method: 'POST',
      url: '/evaluate',
      payload: {
        userId: 'user-4c',
        notificationType: 'marketing_email',
        channel: 'email',
        region: 'EU',
        datetime: '2026-05-21T10:00:00Z',
      },
    });

    const body = JSON.parse(evalRes.body) as EvalResponse;
    expect(body.decision).toBe('deny');
    expect(body.reason).toBe('blocked_by_global_policy');
  });

  it('wildcard region (*) blocks notification for all regions', async () => {
    if (!pool || !server || !globalPolicyRepo) return;

    await globalPolicyRepo.upsert({
      notificationType: 'marketing_push',
      channel: 'push',
      region: '*',
      action: 'deny',
    });

    for (const region of ['EU', 'US', 'APAC', 'LATAM']) {
      const evalRes = await req({
        method: 'POST',
        url: '/evaluate',
        payload: {
          userId: 'user-4d',
          notificationType: 'marketing_push',
          channel: 'push',
          region,
          datetime: '2026-05-21T10:00:00Z',
        },
      });

      const body = JSON.parse(evalRes.body) as EvalResponse;
      expect(body.decision).toBe('deny');
      expect(body.reason).toBe('blocked_by_global_policy');
    }
  });

  it('multiple independent policies do not interfere', async () => {
    if (!pool || !server || !globalPolicyRepo) return;

    await globalPolicyRepo.upsert({
      notificationType: 'marketing_sms',
      channel: 'sms',
      region: 'EU',
      action: 'deny',
    });

    // Different type+channel should not be affected
    const evalRes = await req({
      method: 'POST',
      url: '/evaluate',
      payload: {
        userId: 'user-4e',
        notificationType: 'transactional_email',
        channel: 'email',
        region: 'EU',
        datetime: '2026-05-21T10:00:00Z',
      },
    });

    const body = JSON.parse(evalRes.body) as EvalResponse;
    expect(body.decision).toBe('allow');
    expect(body.reason).toBe('default_preference');
  });
});

// ─── ТЗ Сценарий 5: Идемпотентность ──────────────────────────────────────

describe('ТЗ Сценарий 5: Идемпотентность', () => {
  it('disabling marketing_email twice yields same deny result', async () => {
    if (!pool || !server) return;

    const payload = {
      preferences: [{ notificationType: 'marketing_email', channel: 'email', enabled: false }],
    };

    await req({ method: 'POST', url: '/users/user-5a/preferences', payload });
    await req({ method: 'POST', url: '/users/user-5a/preferences', payload });

    const evalRes = await req({
      method: 'POST',
      url: '/evaluate',
      payload: {
        userId: 'user-5a',
        notificationType: 'marketing_email',
        channel: 'email',
        region: 'US',
        datetime: '2026-05-21T10:00:00Z',
      },
    });

    const body = JSON.parse(evalRes.body) as EvalResponse;
    expect(body.decision).toBe('deny');
    expect(body.reason).toBe('disabled_by_user');
  });

  it('enabling marketing_email twice yields same allow result', async () => {
    if (!pool || !server) return;

    const payload = {
      preferences: [{ notificationType: 'marketing_email', channel: 'email', enabled: true }],
    };

    await req({ method: 'POST', url: '/users/user-5b/preferences', payload });
    await req({ method: 'POST', url: '/users/user-5b/preferences', payload });

    const evalRes = await req({
      method: 'POST',
      url: '/evaluate',
      payload: {
        userId: 'user-5b',
        notificationType: 'marketing_email',
        channel: 'email',
        region: 'US',
        datetime: '2026-05-21T10:00:00Z',
      },
    });

    const body = JSON.parse(evalRes.body) as EvalResponse;
    expect(body.decision).toBe('allow');
    expect(body.reason).toBe('user_preference');
  });

  it('setting quiet hours twice results in only one quiet hours config', async () => {
    if (!pool || !server) return;

    const qhPayload = {
      quietHours: { startHour: 22, startMinute: 0, endHour: 8, endMinute: 0, timezone: 'UTC' },
    };

    await req({ method: 'POST', url: '/users/user-5c/preferences', payload: qhPayload });
    await req({ method: 'POST', url: '/users/user-5c/preferences', payload: qhPayload });

    const getRes = await req({ method: 'GET', url: '/users/user-5c/preferences' });
    const body = JSON.parse(getRes.body) as GetPrefsResponse;

    expect(body.quietHours).toMatchObject({ startHour: 22, endHour: 8, timezone: 'UTC' });
  });

  it('POST preferences returns consistent updatedCount on repeated calls', async () => {
    if (!pool || !server) return;

    const payload = {
      preferences: [{ notificationType: 'marketing_email', channel: 'email', enabled: false }],
    };

    const r1 = await req({ method: 'POST', url: '/users/user-5d/preferences', payload });
    const r2 = await req({ method: 'POST', url: '/users/user-5d/preferences', payload });

    const b1 = JSON.parse(r1.body) as { updatedCount: number };
    const b2 = JSON.parse(r2.body) as { updatedCount: number };

    expect(b1.updatedCount).toBe(1);
    expect(b2.updatedCount).toBe(1);
  });

  it('evaluate returns same result on repeated calls with same input', async () => {
    if (!pool || !server) return;

    const input = {
      userId: 'user-5e',
      notificationType: 'transactional_email',
      channel: 'email',
      region: 'EU',
      datetime: '2026-05-21T10:00:00Z',
    };

    const r1 = await req({ method: 'POST', url: '/evaluate', payload: input });
    const r2 = await req({ method: 'POST', url: '/evaluate', payload: input });
    const r3 = await req({ method: 'POST', url: '/evaluate', payload: input });

    const b1 = JSON.parse(r1.body) as EvalResponse;
    const b2 = JSON.parse(r2.body) as EvalResponse;
    const b3 = JSON.parse(r3.body) as EvalResponse;

    expect(b1).toEqual(b2);
    expect(b2).toEqual(b3);
  });

  it('applying same global policy twice does not create duplicate entries', async () => {
    if (!pool || !server || !globalPolicyRepo) return;

    const policy = {
      notificationType: 'marketing_sms' as const,
      channel: 'sms' as const,
      region: 'EU',
      action: 'deny' as const,
    };

    await globalPolicyRepo.upsert(policy);
    await globalPolicyRepo.upsert(policy);

    const all = await globalPolicyRepo.findAll();
    const euPolicies = all.filter(
      (p) => p.notificationType === 'marketing_sms' && p.region === 'EU',
    );
    expect(euPolicies).toHaveLength(1);
  });
});

// ─── Cascade priority (end-to-end) ────────────────────────────────────────

describe('Cascade priority (end-to-end)', () => {
  it('priority order: global_policy > user_enabled', async () => {
    if (!pool || !server || !globalPolicyRepo) return;

    await globalPolicyRepo.upsert({
      notificationType: 'marketing_email',
      channel: 'email',
      region: 'EU',
      action: 'deny',
    });

    await req({
      method: 'POST',
      url: '/users/priority-user-1/preferences',
      payload: { preferences: [{ notificationType: 'marketing_email', channel: 'email', enabled: true }] },
    });

    const res = await req({
      method: 'POST',
      url: '/evaluate',
      payload: {
        userId: 'priority-user-1',
        notificationType: 'marketing_email',
        channel: 'email',
        region: 'EU',
        datetime: '2026-05-21T10:00:00Z',
      },
    });

    expect(JSON.parse(res.body)).toMatchObject({
      decision: 'deny',
      reason: 'blocked_by_global_policy',
    });
  });

  it('priority order: user_disabled > quiet_hours (reason is disabled_by_user)', async () => {
    if (!pool || !server) return;

    await req({
      method: 'POST',
      url: '/users/priority-user-2/preferences',
      payload: {
        preferences: [{ notificationType: 'marketing_push', channel: 'push', enabled: false }],
        quietHours: { startHour: 22, startMinute: 0, endHour: 8, endMinute: 0, timezone: 'UTC' },
      },
    });

    const res = await req({
      method: 'POST',
      url: '/evaluate',
      payload: {
        userId: 'priority-user-2',
        notificationType: 'marketing_push',
        channel: 'push',
        region: 'US',
        datetime: '2026-05-21T23:00:00Z', // in quiet hours
      },
    });

    // user_disabled (step 2) must come before quiet_hours (step 3)
    expect(JSON.parse(res.body)).toMatchObject({
      decision: 'deny',
      reason: 'disabled_by_user',
    });
  });

  it('priority order: quiet_hours > user_enabled', async () => {
    if (!pool || !server) return;

    await req({
      method: 'POST',
      url: '/users/priority-user-3/preferences',
      payload: {
        preferences: [{ notificationType: 'marketing_push', channel: 'push', enabled: true }],
        quietHours: { startHour: 22, startMinute: 0, endHour: 8, endMinute: 0, timezone: 'UTC' },
      },
    });

    const res = await req({
      method: 'POST',
      url: '/evaluate',
      payload: {
        userId: 'priority-user-3',
        notificationType: 'marketing_push',
        channel: 'push',
        region: 'US',
        datetime: '2026-05-21T23:00:00Z', // in quiet hours
      },
    });

    // quiet_hours (step 3) must override user_enabled (step 4)
    expect(JSON.parse(res.body)).toMatchObject({
      decision: 'deny',
      reason: 'quiet_hours',
    });
  });

  it('priority order: user_enabled > default (user can override default=disabled)', async () => {
    if (!pool || !server) return;

    await req({
      method: 'POST',
      url: '/users/priority-user-4/preferences',
      payload: {
        preferences: [{ notificationType: 'marketing_email', channel: 'email', enabled: true }],
      },
    });

    const res = await req({
      method: 'POST',
      url: '/evaluate',
      payload: {
        userId: 'priority-user-4',
        notificationType: 'marketing_email',
        channel: 'email',
        region: 'US',
        datetime: '2026-05-21T10:00:00Z',
      },
    });

    // marketing_email default = disabled, but user enabled it
    expect(JSON.parse(res.body)).toMatchObject({
      decision: 'allow',
      reason: 'user_preference',
    });
  });
});
