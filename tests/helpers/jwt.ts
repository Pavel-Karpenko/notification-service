import crypto from 'node:crypto';

export const TEST_JWT_SECRET = 'test-jwt-secret-for-testing-minimum-32-chars!!';

function base64url(input: Buffer | string): string {
  const b64 = Buffer.isBuffer(input)
    ? input.toString('base64')
    : Buffer.from(input as string, 'utf8').toString('base64');
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

export interface TokenPayload {
  sub?: string;
  iat?: number;
  exp?: number;
  [key: string]: unknown;
}

export function makeTestToken(payload: TokenPayload = {}): string {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = base64url(
    JSON.stringify({
      sub: 'test-service',
      iat: now,
      exp: now + 3600,
      ...payload,
    }),
  );
  const sig = base64url(
    crypto.createHmac('sha256', TEST_JWT_SECRET).update(`${header}.${body}`).digest(),
  );
  return `${header}.${body}.${sig}`;
}

export function makeExpiredToken(): string {
  const past = Math.floor(Date.now() / 1000) - 7200;
  return makeTestToken({ iat: past, exp: past + 3600 });
}

export function authHeader(payload?: TokenPayload): string {
  return `Bearer ${makeTestToken(payload)}`;
}
