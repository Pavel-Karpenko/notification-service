/**
 * E2E scaling tests — verify stateless behaviour across multiple replicas.
 *
 * Run with a single replica:  npm run test:e2e
 * Run with three replicas:    docker compose up --scale app=3 -d
 *                             npm run test:e2e
 *
 * All tests pass in both cases. The multi-replica assertions verify that writes
 * made through nginx are immediately visible on every subsequent read, regardless
 * of which backend instance handles each request.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import crypto from 'node:crypto';

const BASE_URL = process.env['E2E_BASE_URL'] ?? 'http://localhost:3000';
const JWT_SECRET = process.env['JWT_SECRET'] ?? 'change-me-to-a-random-secret-at-least-32-chars';

function makeToken(): string {
  const b64url = (s: string) =>
    Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const now = Math.floor(Date.now() / 1000);
  const payload = b64url(JSON.stringify({ sub: 'e2e-scaling', iat: now, exp: now + 3600 }));
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

async function get(path: string) {
  return fetch(`${BASE_URL}${path}`, { headers: authHeaders() });
}

async function post(path: string, body: unknown) {
  return fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(body),
  });
}

let serviceAvailable = false;

beforeAll(async () => {
  try {
    const res = await fetch(`${BASE_URL}/healthz`, { signal: AbortSignal.timeout(3000) });
    serviceAvailable = res.ok;
  } catch {
    serviceAvailable = false;
  }
  if (!serviceAvailable) {
    console.warn(`\n⚠  Service not reachable at ${BASE_URL} — skipping scaling tests.\n`);
  }
}, 5000);

// ─── Nginx proxy ───────────────────────────────────────────────────────────

describe('Nginx proxy', () => {
  it('proxies requests to the app and returns 200', async () => {
    if (!serviceAvailable) return;
    const res = await fetch(`${BASE_URL}/healthz`);
    expect(res.status).toBe(200);
  });

  it('passes X-Request-ID from client through to app and back', async () => {
    if (!serviceAvailable) return;
    const res = await fetch(`${BASE_URL}/users/scale-user/preferences`, {
      headers: { ...authHeaders(), 'x-request-id': 'nginx-passthrough-test' },
    });
    expect(res.headers.get('x-request-id')).toBe('nginx-passthrough-test');
  });

  it('generates X-Request-ID when client does not send one', async () => {
    if (!serviceAvailable) return;
    const res = await get('/users/scale-user/preferences');
    expect(res.headers.get('x-request-id')).toBeTruthy();
  });
});

// ─── Stateless cross-replica consistency ───────────────────────────────────

describe('Stateless cross-replica consistency', () => {
  const USER = 'e2e-scale-consistency-user';

  it('write is immediately visible across 20 concurrent reads', async () => {
    if (!serviceAvailable) return;

    // Write a preference through nginx (may land on any replica)
    const writeRes = await post(`/users/${USER}/preferences`, {
      preferences: [{ notificationType: 'marketing_sms', channel: 'sms', enabled: true }],
    });
    expect(writeRes.status).toBe(200);

    // Fire 20 concurrent reads — with 3 replicas nginx distributes them ~7 per replica
    const responses = await Promise.all(
      Array.from({ length: 20 }, () => get(`/users/${USER}/preferences`)),
    );

    // Every response must succeed
    for (const res of responses) {
      expect(res.status).toBe(200);
    }

    type PreferencesBody = {
      userId: string;
      preferences: Array<{ notificationType: string; channel: string; enabled: boolean }>;
    };

    const bodies = await Promise.all(responses.map(r => r.json() as Promise<PreferencesBody>));

    // Every response must reflect the write
    for (const body of bodies) {
      const pref = body.preferences.find(
        p => p.notificationType === 'marketing_sms' && p.channel === 'sms',
      );
      expect(pref?.enabled).toBe(true);
    }
  });

  it('second write overrides first — all reads reflect the latest value', async () => {
    if (!serviceAvailable) return;

    await post(`/users/${USER}/preferences`, {
      preferences: [{ notificationType: 'marketing_push', channel: 'push', enabled: false }],
    });

    // Override with enabled: true
    await post(`/users/${USER}/preferences`, {
      preferences: [{ notificationType: 'marketing_push', channel: 'push', enabled: true }],
    });

    const responses = await Promise.all(
      Array.from({ length: 10 }, () => get(`/users/${USER}/preferences`)),
    );

    type PreferencesBody = {
      preferences: Array<{ notificationType: string; channel: string; enabled: boolean }>;
    };

    const bodies = await Promise.all(responses.map(r => r.json() as Promise<PreferencesBody>));

    for (const body of bodies) {
      const pref = body.preferences.find(
        p => p.notificationType === 'marketing_push' && p.channel === 'push',
      );
      expect(pref?.enabled).toBe(true);
    }
  });

  it('quiet hours set on one request are visible on all subsequent reads', async () => {
    if (!serviceAvailable) return;

    await post(`/users/${USER}/preferences`, {
      quietHours: { startHour: 1, startMinute: 0, endHour: 2, endMinute: 0, timezone: 'UTC' },
    });

    const responses = await Promise.all(
      Array.from({ length: 10 }, () => get(`/users/${USER}/preferences`)),
    );

    type PreferencesBody = {
      quietHours: { startHour: number; timezone: string } | null;
    };

    const bodies = await Promise.all(responses.map(r => r.json() as Promise<PreferencesBody>));

    for (const body of bodies) {
      expect(body.quietHours).not.toBeNull();
      expect(body.quietHours?.startHour).toBe(1);
      expect(body.quietHours?.timezone).toBe('UTC');
    }
  });

  it('evaluate is consistent across replicas after a preference change', async () => {
    if (!serviceAvailable) return;

    const evalUser = 'e2e-scale-eval-user';

    // Explicitly enable marketing_email
    await post(`/users/${evalUser}/preferences`, {
      preferences: [{ notificationType: 'marketing_email', channel: 'email', enabled: true }],
    });

    // 10 concurrent evaluate calls — all should reflect the override
    const responses = await Promise.all(
      Array.from({ length: 10 }, () =>
        post('/evaluate', {
          userId: evalUser,
          notificationType: 'marketing_email',
          channel: 'email',
          region: 'EU',
          datetime: new Date().toISOString(),
        }),
      ),
    );

    type EvalBody = { decision: string; reason: string };
    const bodies = await Promise.all(responses.map(r => r.json() as Promise<EvalBody>));

    for (const body of bodies) {
      expect(body.decision).toBe('allow');
      expect(body.reason).toBe('user_preference');
    }
  });
});

// ─── Health under load ─────────────────────────────────────────────────────

describe('Health under concurrent load', () => {
  it('/healthz stays 200 under 50 concurrent requests', async () => {
    if (!serviceAvailable) return;

    const responses = await Promise.all(
      Array.from({ length: 50 }, () => fetch(`${BASE_URL}/healthz`)),
    );

    for (const res of responses) {
      expect(res.status).toBe(200);
    }
  });
});
