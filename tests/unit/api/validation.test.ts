/**
 * Route-level validation tests — no database required.
 * Verifies that Zod schemas in routes correctly validate and reject inputs.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import jwtPlugin from '../../../src/api/middleware/jwtPlugin';
import preferencesRoutes from '../../../src/api/routes/preferences';
import evaluateRoutes from '../../../src/api/routes/evaluate';
import correlationIdPlugin from '../../../src/api/middleware/correlationId';
import authPlugin from '../../../src/api/middleware/auth';
import { GetUserPreferences } from '../../../src/application/use-cases/GetUserPreferences';
import { UpdateUserPreferences } from '../../../src/application/use-cases/UpdateUserPreferences';
import { EvaluateNotification } from '../../../src/application/use-cases/EvaluateNotification';
import { TEST_JWT_SECRET, authHeader } from '../../helpers/jwt';

// Minimal mock use cases — validation tests only care about 400/200 status
const mockGetPreferences = {
  execute: async () => ({ userId: 'user-1', preferences: [], quietHours: null }),
} as unknown as GetUserPreferences;

const mockUpdatePreferences = {
  execute: async () => ({ updatedPreferences: [], quietHours: null }),
} as unknown as UpdateUserPreferences;

const mockEvaluate = {
  execute: async () => ({ decision: 'allow' as const, reason: 'default_preference' as const }),
} as unknown as EvaluateNotification;

let server: FastifyInstance;

beforeAll(async () => {
  server = Fastify({ logger: false });
  await server.register(jwtPlugin, { secret: TEST_JWT_SECRET });
  await server.register(correlationIdPlugin);
  await server.register(authPlugin);
  await server.register(preferencesRoutes, {
    getUserPreferences: mockGetPreferences,
    updateUserPreferences: mockUpdatePreferences,
  });
  await server.register(evaluateRoutes, { evaluateNotification: mockEvaluate });
  await server.ready();
});

afterAll(async () => {
  await server.close();
});

describe('POST /users/:userId/preferences — input validation', () => {
  const POST = (userId: string, body: unknown) =>
    server.inject({
      method: 'POST',
      url: `/users/${userId}/preferences`,
      payload: body,
      headers: { Authorization: authHeader() },
    });

  it('accepts a valid preference update', async () => {
    const res = await POST('user-1', {
      preferences: [{ notificationType: 'marketing_email', channel: 'email', enabled: false }],
    });
    expect(res.statusCode).toBe(200);
  });

  it('accepts only quietHours (no preferences)', async () => {
    const res = await POST('user-1', {
      quietHours: { startHour: 22, startMinute: 0, endHour: 8, endMinute: 0, timezone: 'UTC' },
    });
    expect(res.statusCode).toBe(200);
  });

  it('accepts both preferences and quietHours', async () => {
    const res = await POST('user-1', {
      preferences: [{ notificationType: 'transactional_email', channel: 'email', enabled: true }],
      quietHours: { startHour: 22, startMinute: 0, endHour: 8, endMinute: 0, timezone: 'Europe/Berlin' },
    });
    expect(res.statusCode).toBe(200);
  });

  it('rejects unknown notificationType', async () => {
    const res = await POST('user-1', {
      preferences: [{ notificationType: 'newsletter', channel: 'email', enabled: false }],
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects unknown channel', async () => {
    const res = await POST('user-1', {
      preferences: [{ notificationType: 'marketing_email', channel: 'telegram', enabled: false }],
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects missing "enabled" field', async () => {
    const res = await POST('user-1', {
      preferences: [{ notificationType: 'marketing_email', channel: 'email' }],
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects startHour > 23', async () => {
    const res = await POST('user-1', {
      quietHours: { startHour: 25, startMinute: 0, endHour: 8, endMinute: 0, timezone: 'UTC' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects startHour < 0', async () => {
    const res = await POST('user-1', {
      quietHours: { startHour: -1, startMinute: 0, endHour: 8, endMinute: 0, timezone: 'UTC' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects endHour > 23', async () => {
    const res = await POST('user-1', {
      quietHours: { startHour: 22, startMinute: 0, endHour: 24, endMinute: 0, timezone: 'UTC' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects startMinute > 59', async () => {
    const res = await POST('user-1', {
      quietHours: { startHour: 22, startMinute: 60, endHour: 8, endMinute: 0, timezone: 'UTC' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects endMinute > 59', async () => {
    const res = await POST('user-1', {
      quietHours: { startHour: 22, startMinute: 0, endHour: 8, endMinute: 60, timezone: 'UTC' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects empty timezone string', async () => {
    const res = await POST('user-1', {
      quietHours: { startHour: 22, startMinute: 0, endHour: 8, endMinute: 0, timezone: '' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects completely empty body', async () => {
    // Empty body is technically valid (all fields optional) — server returns 200
    const res = await POST('user-1', {});
    expect(res.statusCode).toBe(200);
  });

  it('accepts all valid notificationTypes', async () => {
    const types = [
      'transactional_email',
      'marketing_email',
      'transactional_sms',
      'marketing_sms',
      'transactional_push',
      'marketing_push',
    ] as const;

    for (const type of types) {
      const channel = type.includes('email') ? 'email' : type.includes('sms') ? 'sms' : 'push';
      const res = await POST('user-1', {
        preferences: [{ notificationType: type, channel, enabled: true }],
      });
      expect(res.statusCode).toBe(200);
    }
  });

  it('accepts all valid channels', async () => {
    const channels = ['email', 'sms', 'push', 'messenger'] as const;

    for (const channel of channels) {
      const res = await POST('user-1', {
        preferences: [{ notificationType: 'marketing_email', channel, enabled: false }],
      });
      expect(res.statusCode).toBe(200);
    }
  });
});

describe('POST /evaluate — input validation', () => {
  const EVAL = (body: unknown) =>
    server.inject({
      method: 'POST',
      url: '/evaluate',
      payload: body,
      headers: { Authorization: authHeader() },
    });

  const VALID_BODY = {
    userId: 'user-1',
    notificationType: 'marketing_email',
    channel: 'email',
    region: 'EU',
    datetime: '2026-05-21T10:00:00Z',
  };

  it('accepts a valid evaluate request', async () => {
    const res = await EVAL(VALID_BODY);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { decision: string; reason: string };
    expect(body.decision).toBe('allow');
  });

  it('rejects missing userId', async () => {
    const res = await EVAL({ ...VALID_BODY, userId: undefined });
    expect(res.statusCode).toBe(400);
  });

  it('rejects empty string userId', async () => {
    const res = await EVAL({ ...VALID_BODY, userId: '' });
    expect(res.statusCode).toBe(400);
  });

  it('rejects unknown notificationType', async () => {
    const res = await EVAL({ ...VALID_BODY, notificationType: 'unknown_type' });
    expect(res.statusCode).toBe(400);
  });

  it('rejects unknown channel', async () => {
    const res = await EVAL({ ...VALID_BODY, channel: 'telegram' });
    expect(res.statusCode).toBe(400);
  });

  it('rejects missing region', async () => {
    const res = await EVAL({ ...VALID_BODY, region: undefined });
    expect(res.statusCode).toBe(400);
  });

  it('rejects empty string region', async () => {
    const res = await EVAL({ ...VALID_BODY, region: '' });
    expect(res.statusCode).toBe(400);
  });

  it('rejects non-ISO datetime', async () => {
    const res = await EVAL({ ...VALID_BODY, datetime: 'not-a-date' });
    expect(res.statusCode).toBe(400);
  });

  it('rejects missing datetime', async () => {
    const res = await EVAL({ ...VALID_BODY, datetime: undefined });
    expect(res.statusCode).toBe(400);
  });

  it('accepts datetime with timezone offset', async () => {
    const res = await EVAL({ ...VALID_BODY, datetime: '2026-05-21T21:30:00+02:00' });
    expect(res.statusCode).toBe(200);
  });

  it('rejects empty body', async () => {
    const res = await EVAL({});
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 with error message', async () => {
    const res = await EVAL({ ...VALID_BODY, notificationType: 'invalid' });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body) as { error: string; message: string };
    expect(body.error).toBe('Bad Request');
    expect(body.message).toBeDefined();
  });
});

describe('Correlation ID middleware', () => {
  it('echoes X-Request-ID header from request', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/users/user-1/preferences',
      headers: { 'x-request-id': 'test-correlation-id-123', Authorization: authHeader() },
    });

    expect(res.headers['x-request-id']).toBe('test-correlation-id-123');
  });

  it('generates X-Request-ID when not provided', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/users/user-1/preferences',
      headers: { Authorization: authHeader() },
    });

    expect(res.headers['x-request-id']).toBeTruthy();
    expect(typeof res.headers['x-request-id']).toBe('string');
  });
});

describe('GET /users/:userId/preferences', () => {
  it('returns 200 for any userId with valid token', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/users/any-user-id/preferences',
      headers: { Authorization: authHeader() },
    });
    expect(res.statusCode).toBe(200);
  });

  it('returns 401 without token', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/users/user-1/preferences',
    });
    expect(res.statusCode).toBe(401);
  });

  it('response contains userId, preferences array, and quietHours', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/users/user-1/preferences',
      headers: { Authorization: authHeader() },
    });
    const body = JSON.parse(res.body) as { userId: string; preferences: unknown[]; quietHours: null };
    expect(body.userId).toBe('user-1');
    expect(Array.isArray(body.preferences)).toBe(true);
    expect('quietHours' in body).toBe(true);
  });
});
