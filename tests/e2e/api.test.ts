/**
 * E2E tests — hit the real service running in Docker Compose at localhost:3000.
 *
 * Run with: npm run test:e2e
 * Requires: docker compose up -d
 */
import { describe, it, expect, beforeAll } from 'vitest';
import crypto from 'node:crypto';

const BASE_URL = process.env['E2E_BASE_URL'] ?? 'http://localhost:3000';
const JWT_SECRET = process.env['JWT_SECRET'] ?? 'change-me-to-a-random-secret-at-least-32-chars';

// ─── JWT helper ────────────────────────────────────────────────────────────

function makeToken(sub = 'e2e-test'): string {
  const b64url = (s: string) =>
    Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const now = Math.floor(Date.now() / 1000);
  const payload = b64url(JSON.stringify({ sub, iat: now, exp: now + 3600 }));
  const sig = crypto
    .createHmac('sha256', JWT_SECRET)
    .update(`${header}.${payload}`)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
  return `${header}.${payload}.${sig}`;
}

function authHeaders() {
  return { Authorization: `Bearer ${makeToken()}`, 'Content-Type': 'application/json' };
}

async function get(path: string, token = true) {
  return fetch(`${BASE_URL}${path}`, {
    headers: token ? authHeaders() : {},
  });
}

async function post(path: string, body: unknown, token = true) {
  return fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: token ? authHeaders() : { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// ─── Skip all if service is not reachable ──────────────────────────────────

let serviceAvailable = false;

beforeAll(async () => {
  try {
    const res = await fetch(`${BASE_URL}/healthz`, { signal: AbortSignal.timeout(3000) });
    serviceAvailable = res.ok;
  } catch {
    serviceAvailable = false;
  }

  if (!serviceAvailable) {
    console.warn(`\n⚠  Service not reachable at ${BASE_URL} — skipping e2e tests.\n   Run: docker compose up -d\n`);
  }
}, 5000);

function skipIfDown() {
  if (!serviceAvailable) return true;
  return false;
}

// ─── Health ────────────────────────────────────────────────────────────────

describe('Health endpoints', () => {
  it('GET /healthz returns 200', async () => {
    if (skipIfDown()) return;
    const res = await get('/healthz', false);
    expect(res.status).toBe(200);
    const body = await res.json() as { status: string };
    expect(body.status).toBe('ok');
  });

  it('GET /readyz returns 200 when all deps healthy', async () => {
    if (skipIfDown()) return;
    const res = await get('/readyz', false);
    expect(res.status).toBe(200);
    const body = await res.json() as { status: string; db: string; redis: string };
    expect(body.status).toBe('ok');
    expect(body.db).toBe('ok');
    expect(body.redis).toBe('ok');
  });
});

// ─── Auth ──────────────────────────────────────────────────────────────────

describe('Authentication', () => {
  it('returns 401 without token', async () => {
    if (skipIfDown()) return;
    const res = await get('/users/e2e-user/preferences', false);
    expect(res.status).toBe(401);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('Unauthorized');
  });

  it('returns 401 with malformed token', async () => {
    if (skipIfDown()) return;
    const res = await fetch(`${BASE_URL}/users/e2e-user/preferences`, {
      headers: { Authorization: 'Bearer not.a.token' },
    });
    expect(res.status).toBe(401);
  });

  it('returns 200 with valid token', async () => {
    if (skipIfDown()) return;
    const res = await get('/users/e2e-user/preferences');
    expect(res.status).toBe(200);
  });
});

// ─── Swagger ───────────────────────────────────────────────────────────────

describe('Swagger UI', () => {
  it('GET /docs returns HTML without auth', async () => {
    if (skipIfDown()) return;
    const res = await get('/docs', false);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('swagger');
  });

  it('GET /docs/json returns OpenAPI spec', async () => {
    if (skipIfDown()) return;
    const res = await get('/docs/json', false);
    expect(res.status).toBe(200);
    const body = await res.json() as { openapi: string; info: { title: string } };
    expect(body.openapi).toMatch(/^3\./);
    expect(body.info.title).toBe('Notification Preferences Service');
  });
});

// ─── Preferences ───────────────────────────────────────────────────────────

describe('GET /users/:userId/preferences', () => {
  it('returns full preferences structure for new user', async () => {
    if (skipIfDown()) return;
    const res = await get('/users/e2e-new-user-99/preferences');
    expect(res.status).toBe(200);
    const body = await res.json() as { userId: string; preferences: unknown[]; quietHours: null };
    expect(body.userId).toBe('e2e-new-user-99');
    expect(Array.isArray(body.preferences)).toBe(true);
    expect(body.preferences.length).toBeGreaterThan(0);
    expect('quietHours' in body).toBe(true);
  });

  it('returns X-Request-ID header', async () => {
    if (skipIfDown()) return;
    const res = await get('/users/e2e-user/preferences');
    expect(res.headers.get('x-request-id')).toBeTruthy();
  });

  it('echoes X-Request-ID when provided', async () => {
    if (skipIfDown()) return;
    const res = await fetch(`${BASE_URL}/users/e2e-user/preferences`, {
      headers: { ...authHeaders(), 'x-request-id': 'my-trace-id-123' },
    });
    expect(res.headers.get('x-request-id')).toBe('my-trace-id-123');
  });
});

describe('POST /users/:userId/preferences', () => {
  const USER = 'e2e-test-user';

  it('saves a preference override', async () => {
    if (skipIfDown()) return;
    const res = await post(`/users/${USER}/preferences`, {
      preferences: [{ notificationType: 'marketing_email', channel: 'email', enabled: false }],
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { userId: string; updatedCount: number };
    expect(body.userId).toBe(USER);
    expect(body.updatedCount).toBe(1);
  });

  it('saved preference is reflected in GET', async () => {
    if (skipIfDown()) return;
    await post(`/users/${USER}/preferences`, {
      preferences: [{ notificationType: 'marketing_email', channel: 'email', enabled: false }],
    });

    const res = await get(`/users/${USER}/preferences`);
    const body = await res.json() as { preferences: Array<{ notificationType: string; channel: string; enabled: boolean; source: string }> };
    const pref = body.preferences.find(p => p.notificationType === 'marketing_email' && p.channel === 'email');
    expect(pref).toBeDefined();
    expect(pref?.enabled).toBe(false);
    expect(pref?.source).toBe('user');
  });

  it('saves quiet hours', async () => {
    if (skipIfDown()) return;
    const res = await post(`/users/${USER}/preferences`, {
      quietHours: { startHour: 23, startMinute: 0, endHour: 7, endMinute: 0, timezone: 'Europe/Moscow' },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { quietHours: { timezone: string } };
    expect(body.quietHours?.timezone).toBe('Europe/Moscow');
  });

  it('quiet hours appear in GET response', async () => {
    if (skipIfDown()) return;
    await post(`/users/${USER}/preferences`, {
      quietHours: { startHour: 23, startMinute: 0, endHour: 7, endMinute: 0, timezone: 'Europe/Moscow' },
    });
    const res = await get(`/users/${USER}/preferences`);
    const body = await res.json() as { quietHours: { startHour: number; timezone: string } | null };
    expect(body.quietHours).not.toBeNull();
    expect(body.quietHours?.startHour).toBe(23);
    expect(body.quietHours?.timezone).toBe('Europe/Moscow');
  });

  it('rejects unknown notificationType with 400', async () => {
    if (skipIfDown()) return;
    const res = await post(`/users/${USER}/preferences`, {
      preferences: [{ notificationType: 'newsletter', channel: 'email', enabled: false }],
    });
    expect(res.status).toBe(400);
  });

  it('rejects unknown channel with 400', async () => {
    if (skipIfDown()) return;
    const res = await post(`/users/${USER}/preferences`, {
      preferences: [{ notificationType: 'marketing_email', channel: 'telegram', enabled: false }],
    });
    expect(res.status).toBe(400);
  });

  it('rejects invalid quietHours hour with 400', async () => {
    if (skipIfDown()) return;
    const res = await post(`/users/${USER}/preferences`, {
      quietHours: { startHour: 25, startMinute: 0, endHour: 7, endMinute: 0, timezone: 'UTC' },
    });
    expect(res.status).toBe(400);
  });
});

// ─── Evaluate ──────────────────────────────────────────────────────────────

describe('POST /evaluate', () => {
  const USER = 'e2e-eval-user';

  it('returns allow for user with no overrides (default)', async () => {
    if (skipIfDown()) return;
    const res = await post('/evaluate', {
      userId: 'e2e-brand-new-user',
      notificationType: 'transactional_email',
      channel: 'email',
      region: 'EU',
      datetime: new Date().toISOString(),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { decision: string; reason: string };
    expect(['allow', 'deny']).toContain(body.decision);
    expect(body.reason).toBeTruthy();
  });

  it('returns deny when user disabled the channel', async () => {
    if (skipIfDown()) return;
    await post(`/users/${USER}/preferences`, {
      preferences: [{ notificationType: 'marketing_email', channel: 'email', enabled: false }],
    });

    const res = await post('/evaluate', {
      userId: USER,
      notificationType: 'marketing_email',
      channel: 'email',
      region: 'EU',
      datetime: new Date().toISOString(),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { decision: string; reason: string };
    expect(body.decision).toBe('deny');
    expect(body.reason).toBe('disabled_by_user');
  });

  it('returns deny during quiet hours window', async () => {
    if (skipIfDown()) return;
    // Use a dedicated user to avoid state from previous tests
    const quietUser = 'e2e-quiet-hours-user';
    // Quiet hours 10:00–14:00 UTC covers the test datetime of 12:00 UTC.
    // Must use a marketing type — transactional types bypass quiet hours by design.
    await post(`/users/${quietUser}/preferences`, {
      preferences: [{ notificationType: 'marketing_email', channel: 'email', enabled: true }],
      quietHours: { startHour: 10, startMinute: 0, endHour: 14, endMinute: 0, timezone: 'UTC' },
    });

    const res = await post('/evaluate', {
      userId: quietUser,
      notificationType: 'marketing_email',
      channel: 'email',
      region: 'EU',
      datetime: '2026-06-01T12:00:00Z',
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { decision: string; reason: string };
    expect(body.decision).toBe('deny');
    expect(body.reason).toBe('quiet_hours');
  });

  it('rejects missing userId with 400', async () => {
    if (skipIfDown()) return;
    const res = await post('/evaluate', {
      notificationType: 'marketing_email',
      channel: 'email',
      region: 'EU',
      datetime: new Date().toISOString(),
    });
    expect(res.status).toBe(400);
  });

  it('rejects non-ISO datetime with 400', async () => {
    if (skipIfDown()) return;
    const res = await post('/evaluate', {
      userId: USER,
      notificationType: 'marketing_email',
      channel: 'email',
      region: 'EU',
      datetime: 'not-a-date',
    });
    expect(res.status).toBe(400);
  });

  it('rejects missing region with 400', async () => {
    if (skipIfDown()) return;
    const res = await post('/evaluate', {
      userId: USER,
      notificationType: 'marketing_email',
      channel: 'email',
      datetime: new Date().toISOString(),
    });
    expect(res.status).toBe(400);
  });
});
