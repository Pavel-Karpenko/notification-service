#!/usr/bin/env node
/**
 * Load generator — produces traffic across all evaluation scenarios
 * so Grafana dashboard panels have data to display.
 *
 * Usage:
 *   node scripts/load.js                         # 6 rounds against localhost:3000
 *   ROUNDS=20 node scripts/load.js               # more rounds
 *   E2E_BASE_URL=http://staging.example.com node scripts/load.js
 */
const crypto = require('crypto');

const BASE    = process.env['E2E_BASE_URL'] ?? 'http://localhost:3000';
const SECRET  = process.env['JWT_SECRET']   ?? 'change-me-to-a-random-secret-at-least-32-chars';
const ROUNDS  = parseInt(process.env['ROUNDS'] ?? '6', 10);
const DELAY   = parseInt(process.env['DELAY_MS'] ?? '2000', 10);

function makeToken() {
  const b64url = s =>
    Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  const header  = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const now     = Math.floor(Date.now() / 1000);
  const payload = b64url(JSON.stringify({ sub: 'load-script', iat: now, exp: now + 3600 }));
  const sig     = crypto
    .createHmac('sha256', SECRET)
    .update(`${header}.${payload}`)
    .digest('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  return `${header}.${payload}.${sig}`;
}

const TOKEN = makeToken();
const HEADERS = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };

const TYPES   = ['transactional_email', 'marketing_email', 'transactional_sms', 'marketing_sms', 'transactional_push', 'marketing_push'];
const CHANNELS = ['email', 'email', 'sms', 'sms', 'push', 'push'];
const REGIONS  = ['EU', 'US', 'APAC', 'LATAM', 'OTHER', 'EU'];
const USERS    = 8;

async function request(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: HEADERS,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok && res.status !== 400) {
    console.warn(`  ${method} ${path} → ${res.status}`);
  }
  return res;
}

async function setup() {
  // Create users with mixed preferences: some with marketing disabled, some with quiet hours
  for (let u = 1; u <= USERS; u++) {
    const marketingEnabled = u % 3 !== 0;   // 2 out of 3 users have marketing disabled
    const hasQuietHours    = u % 2 === 0;   // even-numbered users have quiet hours
    const body = {
      preferences: [
        { notificationType: 'marketing_email', channel: 'email', enabled: marketingEnabled },
        { notificationType: 'marketing_sms',   channel: 'sms',   enabled: marketingEnabled },
      ],
    };
    if (hasQuietHours) {
      body.quietHours = { startHour: 0, startMinute: 0, endHour: 1, endMinute: 0, timezone: 'UTC' };
    }
    await request('POST', `/users/load-user-${u}/preferences`, body);
  }
  console.log(`  Users 1–${USERS} configured`);
}

async function runRound(round) {
  const batch = [];

  // Evaluate all type/channel combinations for all users — produces allow + deny metrics
  for (let i = 0; i < TYPES.length; i++) {
    for (let u = 1; u <= USERS; u++) {
      batch.push(request('POST', '/evaluate', {
        userId:           `load-user-${u}`,
        notificationType: TYPES[i],
        channel:          CHANNELS[i],
        region:           REGIONS[i % REGIONS.length],
        datetime:         new Date().toISOString(),
      }));
    }
  }

  // GET preferences — produces cache hit/miss metrics (cache warms after first round)
  for (let u = 1; u <= USERS; u++) {
    batch.push(request('GET', `/users/load-user-${u}/preferences`));
    batch.push(request('GET', `/users/load-user-${u}/preferences`));  // second hit → cache hit
  }

  // Health checks — HTTP request rate
  for (let i = 0; i < 5; i++) {
    batch.push(fetch(`${BASE}/healthz`));
  }

  await Promise.all(batch);
  console.log(`  Round ${round}/${ROUNDS} — ${batch.length} requests sent`);
}

async function main() {
  console.log(`Load generator started`);
  console.log(`  Target:  ${BASE}`);
  console.log(`  Rounds:  ${ROUNDS}  (delay ${DELAY}ms between rounds)`);
  console.log();

  // Quick reachability check
  try {
    const res = await fetch(`${BASE}/healthz`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) throw new Error(`/healthz returned ${res.status}`);
  } catch (e) {
    console.error(`Service not reachable at ${BASE}: ${e.message}`);
    console.error('Run: docker compose up -d');
    process.exit(1);
  }

  console.log('Setting up users...');
  await setup();
  console.log();

  console.log('Generating load...');
  for (let r = 1; r <= ROUNDS; r++) {
    await runRound(r);
    if (r < ROUNDS) await new Promise(resolve => setTimeout(resolve, DELAY));
  }

  console.log();
  console.log('Done. Open Grafana: http://localhost:3001');
}

main().catch(e => { console.error(e); process.exit(1); });
