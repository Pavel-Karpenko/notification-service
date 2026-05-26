import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import jwtPlugin from '../../../src/api/middleware/jwtPlugin';
import authPlugin from '../../../src/api/middleware/auth';
import { TEST_JWT_SECRET, authHeader, makeExpiredToken } from '../../helpers/jwt';

let server: FastifyInstance;

beforeAll(async () => {
  server = Fastify({ logger: false });

  await server.register(jwtPlugin, { secret: TEST_JWT_SECRET });
  await server.register(authPlugin);

  // Protected route — requires a valid token
  server.get('/protected', async () => ({ ok: true }));

  // Route for testing user.sub propagation
  server.get('/whoami', async (request) => ({ sub: request.user.sub }));

  // Public route — should bypass auth (registered in auth.ts PUBLIC_PATHS)
  server.get('/healthz', async () => ({ status: 'ok' }));
  server.get('/readyz', async () => ({ status: 'ok' }));
  server.get('/metrics', async () => 'metrics');

  await server.ready();
});

afterAll(async () => {
  await server.close();
});

describe('Protected routes', () => {
  it('returns 401 when Authorization header is missing', async () => {
    const res = await server.inject({ method: 'GET', url: '/protected' });
    expect(res.statusCode).toBe(401);
  });

  it('returns 401 when token is malformed', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/protected',
      headers: { Authorization: 'Bearer not.a.jwt' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('returns 401 when token is signed with a wrong secret', async () => {
    const { makeTestToken } = await import('../../helpers/jwt');
    // Sign with a different secret by patching the token
    const token = makeTestToken();
    const parts = token.split('.');
    // Tamper with the signature
    const tamperedToken = `${parts[0]}.${parts[1]}.invalidsignature`;

    const res = await server.inject({
      method: 'GET',
      url: '/protected',
      headers: { Authorization: `Bearer ${tamperedToken}` },
    });
    expect(res.statusCode).toBe(401);
  });

  it('returns 401 when token is expired', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/protected',
      headers: { Authorization: `Bearer ${makeExpiredToken()}` },
    });
    expect(res.statusCode).toBe(401);
  });

  it('returns 401 when Authorization uses wrong scheme (Basic instead of Bearer)', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/protected',
      headers: { Authorization: 'Basic dXNlcjpwYXNz' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('returns 200 with a valid Bearer token', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/protected',
      headers: { Authorization: authHeader() },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true });
  });

  it('401 response has correct error shape', async () => {
    const res = await server.inject({ method: 'GET', url: '/protected' });
    const body = JSON.parse(res.body) as { error: string; message: string };
    expect(body.error).toBe('Unauthorized');
    expect(body.message).toBe('Valid Bearer token required');
  });
});

describe('Public routes bypass authentication', () => {
  it('GET /healthz returns 200 without a token', async () => {
    const res = await server.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
  });

  it('GET /readyz returns 200 without a token', async () => {
    const res = await server.inject({ method: 'GET', url: '/readyz' });
    expect(res.statusCode).toBe(200);
  });

  it('GET /metrics returns 200 without a token', async () => {
    const res = await server.inject({ method: 'GET', url: '/metrics' });
    expect(res.statusCode).toBe(200);
  });

  it('public routes also accept a token (no rejection)', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/healthz',
      headers: { Authorization: authHeader() },
    });
    expect(res.statusCode).toBe(200);
  });
});

describe('Token payload is accessible on request', () => {
  it('request.user.sub contains the token subject', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/whoami',
      headers: { Authorization: authHeader({ sub: 'user-42' }) },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ sub: 'user-42' });
  });
});
