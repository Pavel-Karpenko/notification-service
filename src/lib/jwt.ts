import crypto from 'node:crypto';

export interface JWTPayload {
  sub?: string;
  iat?: number;
  exp?: number;
  [key: string]: unknown;
}

function base64urlDecode(s: string): string {
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

export function verifyHS256(token: string, secret: string): JWTPayload {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('malformed_jwt');
  const [headerB64, payloadB64, sig] = parts;
  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${headerB64}.${payloadB64}`)
    .digest('base64url');
  if (expected !== sig) throw new Error('invalid_signature');
  const decoded = JSON.parse(base64urlDecode(payloadB64)) as JWTPayload;
  if (decoded.exp != null && decoded.exp < Math.floor(Date.now() / 1000)) {
    throw new Error('token_expired');
  }
  return decoded;
}
