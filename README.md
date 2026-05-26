# Notification Preferences Service

A REST API service for managing user notification preferences and deciding whether a notification should be delivered. Built with **Fastify**, **PostgreSQL**, **Redis**, and **TypeScript**.

> Russian version: [README.ru.md](./README.ru.md)

---

## Table of Contents

- [Overview](#overview)
- [Architecture](#architecture)
- [Quick Start](#quick-start)
- [Local Development](#local-development)
- [Authentication](#authentication)
- [API Reference](#api-reference)
- [Testing](#testing)
- [Observability](#observability)
- [Scaling](#scaling)

---

## Overview

The service answers one question: **should this notification be sent right now?**

The evaluation cascade (highest to lowest priority):

| Step | Condition | Result |
|------|-----------|--------|
| 1 | Global policy blocks this type/channel/region | `deny: blocked_by_global_policy` |
| 2 | User explicitly disabled this type/channel | `deny: disabled_by_user` |
| 3 | Current time is within user's quiet hours *(marketing types only)* | `deny: quiet_hours` |
| 4 | User explicitly enabled this type/channel | `allow: user_preference` |
| 5 | Fall back to system defaults | `allow/deny: default_preference` |

**Default preferences** (seeded on first run):

| Type | Channel | Default |
|------|---------|---------|
| `transactional_email` | email | ✅ allow |
| `marketing_email` | email | ❌ deny |
| `transactional_sms` | sms | ✅ allow |
| `marketing_sms` | sms | ❌ deny |
| `transactional_push` | push | ✅ allow |
| `marketing_push` | push | ❌ deny |

---

## Architecture

```
src/
├── domain/             # Core business logic — no framework dependencies
│   ├── types.ts            NotificationType, Channel, Region, EvaluateResult
│   ├── entities/           UserPreference, GlobalPolicy, QuietHours
│   ├── repositories/       Repository interfaces (no implementations)
│   └── services/
│       └── EvaluationService.ts   5-step evaluation cascade
├── application/
│   └── use-cases/          GetUserPreferences, UpdateUserPreferences, EvaluateNotification
├── infrastructure/
│   ├── db/                 PostgreSQL via pg + Drizzle schema, migrations
│   ├── cache/              RedisCache (cache-aside), NoopCache for tests
│   ├── metrics/            prom-client counters and histograms
│   └── logger/             Pino structured JSON logger
├── api/                # HTTP layer (Fastify 4)
│   ├── routes/             preferences, evaluate, health
│   ├── middleware/         JWT auth, Correlation ID (X-Request-ID)
│   ├── swagger.ts          OpenAPI 3.0 spec (@fastify/swagger)
│   └── server.ts
└── config/             Zod-validated environment config
```

**Key design decisions:**
- **Dependency Inversion** — `EvaluationService` depends only on repository interfaces, not concrete implementations.
- **Cache-aside with Redis** — user prefs cached for 60 s, global policies for 300 s; invalidated on write.
- **Stateless app** — all state lives in PostgreSQL and Redis; run any number of replicas without coordination.
- **Idempotency** — `POST /preferences` uses `ON CONFLICT DO UPDATE`; repeated calls with the same payload are safe.
- **Quiet hours via Luxon** — correct IANA timezone handling and midnight crossover.

---

## Quick Start

### Prerequisites

- [Docker](https://docs.docker.com/get-docker/) with Compose v2

### Run the full stack

```bash
git clone <repo-url>
cd notification-service

docker compose up --build
```

This starts:

| Service | URL | Credentials |
|---------|-----|-------------|
| API (via Nginx) | http://localhost:3000 | JWT token (see below) |
| Swagger UI | http://localhost:3000/docs | — |
| Prometheus | http://localhost:9090 | — |
| Grafana | http://localhost:3001 | admin / admin |

Nginx sits in front of the app container(s) and load-balances requests across all replicas. Migrations and default preference seeding run automatically on app startup.

### Stop and clean up

```bash
# Stop containers, keep volumes
docker compose down

# Stop and wipe all data
docker compose down -v
```

---

## Local Development

```bash
# 1. Install dependencies
npm install

# 2. Start only infrastructure
docker compose up postgres redis -d

# 3. Set environment variables
export DATABASE_URL=postgresql://postgres:postgres@localhost:5432/notifications
export REDIS_URL=redis://localhost:6379
export JWT_SECRET=local-dev-secret-minimum-32-characters
export PORT=3000

# 4. Run migrations
npm run build && npm run migrate

# 5. Start dev server with hot-reload
npm run dev
```

### Build for production

```bash
npm run build      # compiles TypeScript to dist/
npm start          # runs dist/index.js
```

### Lint

```bash
npm run lint       # tsc --noEmit + eslint
npm run lint:fix   # auto-fix eslint issues
```

---

## Authentication

All API endpoints except `/healthz`, `/readyz`, `/metrics`, and `/docs` require a **Bearer JWT token** (HS256, signed with `JWT_SECRET`).

### Generate a token

```bash
node -e "
const crypto = require('crypto');
const SECRET = process.env.JWT_SECRET ?? 'change-me-to-a-random-secret-at-least-32-chars';
const b64url = b => Buffer.from(b).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
const now = Math.floor(Date.now() / 1000);
const payload = b64url(JSON.stringify({ sub: 'my-service', iat: now, exp: now + 3600 }));
const sig = crypto.createHmac('sha256', SECRET).update(header+'.'+payload).digest('base64')
  .replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
console.log(header + '.' + payload + '.' + sig);
"
```

Save it:
```bash
export TOKEN=$(node -e "...")   # same script as above
```

### Use in Swagger UI

1. Open http://localhost:3000/docs
2. Click **Authorize** (top right)
3. Paste the token — **without** the `Bearer ` prefix (Swagger adds it automatically)
4. Click **Authorize**, then close the dialog

---

## API Reference

### GET /users/:userId/preferences

Returns the merged preference view for a user: explicit overrides take precedence, everything else falls back to system defaults.

```bash
curl http://localhost:3000/users/alice/preferences \
  -H "Authorization: Bearer $TOKEN"
```

```json
{
  "userId": "alice",
  "preferences": [
    { "notificationType": "transactional_email", "channel": "email", "enabled": true,  "source": "default" },
    { "notificationType": "marketing_email",     "channel": "email", "enabled": false, "source": "default" },
    { "notificationType": "transactional_sms",   "channel": "sms",   "enabled": true,  "source": "default" },
    { "notificationType": "marketing_sms",       "channel": "sms",   "enabled": false, "source": "default" },
    { "notificationType": "transactional_push",  "channel": "push",  "enabled": true,  "source": "default" },
    { "notificationType": "marketing_push",      "channel": "push",  "enabled": false, "source": "default" }
  ],
  "quietHours": null
}
```

The `source` field is either `"user"` (explicit override) or `"default"` (system default).

---

### POST /users/:userId/preferences

Upserts one or more channel preferences and/or sets quiet hours. Idempotent.

Both `preferences` and `quietHours` are optional — send one or both.

**Disable marketing emails and set quiet hours:**

```bash
curl -X POST http://localhost:3000/users/alice/preferences \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "preferences": [
      { "notificationType": "marketing_email", "channel": "email", "enabled": false },
      { "notificationType": "transactional_sms", "channel": "sms", "enabled": true }
    ],
    "quietHours": {
      "startHour": 22,
      "startMinute": 0,
      "endHour": 8,
      "endMinute": 0,
      "timezone": "Europe/London"
    }
  }'
```

```json
{
  "userId": "alice",
  "updatedCount": 2,
  "quietHours": {
    "startHour": 22,
    "startMinute": 0,
    "endHour": 8,
    "endMinute": 0,
    "timezone": "Europe/London"
  }
}
```

**Valid notification types:** `transactional_email`, `marketing_email`, `transactional_sms`, `marketing_sms`, `transactional_push`, `marketing_push`

**Valid channels:** `email`, `sms`, `push`, `messenger`

**Quiet hours fields:**
- `startHour` / `endHour` — integer 0–23
- `startMinute` / `endMinute` — integer 0–59
- `timezone` — any IANA timezone string (e.g. `UTC`, `America/New_York`, `Asia/Tokyo`)
- Midnight crossover is supported (e.g. 22:00–06:00)

---

### POST /evaluate

Evaluates whether a notification should be sent. Runs the full 5-step cascade.

```bash
curl -X POST http://localhost:3000/evaluate \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "userId": "alice",
    "notificationType": "marketing_email",
    "channel": "email",
    "region": "EU",
    "datetime": "2026-06-01T23:30:00Z"
  }'
```

```json
{
  "decision": "deny",
  "reason": "quiet_hours"
}
```

**Request fields:**

| Field | Type | Description |
|-------|------|-------------|
| `userId` | string | Recipient user identifier |
| `notificationType` | enum | One of the 6 notification types |
| `channel` | enum | `email`, `sms`, `push`, or `messenger` |
| `region` | string | `EU`, `US`, `APAC`, `LATAM`, `OTHER`, or custom |
| `datetime` | ISO 8601 | Point in time for the evaluation (used for quiet hours check) |

**Possible reasons:**

| Reason | Decision | Meaning |
|--------|----------|---------|
| `blocked_by_global_policy` | deny | Admin policy blocks this type/channel/region |
| `disabled_by_user` | deny | User explicitly turned this off |
| `quiet_hours` | deny | Request time falls within user's quiet window |
| `user_preference` | allow | User explicitly turned this on |
| `default_preference` | allow / deny | No override — system default applies |

---

### GET /healthz

Liveness probe. Returns `200` as long as the process is running.

```bash
curl http://localhost:3000/healthz
# {"status":"ok"}
```

### GET /readyz

Readiness probe. Returns `200` when both PostgreSQL and Redis are reachable, `503` otherwise.

```bash
curl http://localhost:3000/readyz
# {"status":"ok","db":"ok","redis":"ok"}
```

### GET /metrics

Prometheus metrics endpoint. Used by the bundled Prometheus container.

---

## Testing

### Unit tests

No infrastructure required. Run in isolation.

```bash
npm run test:unit
```

Covers: domain logic (`EvaluationService`, `QuietHours`, cascade), use cases, Redis cache, input validation, JWT auth middleware, route handlers with mock use cases.

### Integration tests

Require a running PostgreSQL instance. The test database is **created automatically** if it does not exist — no manual setup needed.

```bash
# Start only the database
docker compose up postgres -d

# Run integration tests (the test DB is created automatically on first run)
TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/notifications_test \
  npm run test:integration
```

Covers: end-to-end scenarios using real DB repositories — global policy blocking, user disable, quiet hours, user override, default fallback.

### E2E tests

Hit the **real running service** at `localhost:3000` (through Nginx). Require the full Docker Compose stack to be up.

```bash
# Start the full stack first (single replica)
docker compose up -d

# Run e2e tests
npm run test:e2e
```

If the service is unreachable, all e2e tests are skipped gracefully with a warning — safe to run in CI without the stack.

**Override the base URL:**
```bash
E2E_BASE_URL=http://staging.example.com npm run test:e2e
```

**What the e2e suite covers (`tests/e2e/api.test.ts`):**
- Health probes (`/healthz`, `/readyz`)
- 401 without token, 401 with invalid token, 200 with valid token
- Swagger UI accessible without auth (`/docs`, `/docs/json`)
- GET preferences — response shape, `X-Request-ID` echo
- POST preferences — save override, read it back, quiet hours round-trip, 400 on bad input
- POST evaluate — allow on default, deny on user-disabled, deny during quiet hours, 400 validation

### E2E scaling tests

Verify stateless behaviour across multiple replicas (`tests/e2e/scaling.test.ts`).

```bash
# Scale to 3 replicas first
docker compose up --scale app=3 -d

# Run all e2e tests (api + scaling)
npm run test:e2e
```

**What the scaling suite covers:**
- Nginx proxies requests and passes `X-Request-ID` through
- Write visible on all 20 concurrent reads (hitting different replicas)
- Second write overrides first — all reads reflect the latest value
- Quiet hours set once are visible across all replicas
- Evaluate results are consistent across replicas after a preference change
- `/healthz` stays 200 under 50 concurrent requests

### Run all tests

```bash
npm test
```

This runs unit + integration tests. E2E is a separate step because it requires the stack.

---

## Observability

| Signal | Details |
|--------|---------|
| Structured logs | Pino JSON, one log line per request with `reqId` (correlation ID) |
| `X-Request-ID` | Echoed from the request header or auto-generated (UUID v4) |
| Prometheus metrics | Available at `/metrics` |
| Grafana dashboard | Pre-provisioned at http://localhost:3001 |

**Key Prometheus metrics:**

- `http_request_duration_seconds` — latency histogram by method, route, status code
- `notifications_evaluated_total` — evaluation counter by decision, reason, channel, type
- `cache_hits_total` / `cache_misses_total` — Redis cache hit/miss counters

### Grafana

1. Open **http://localhost:3001**
2. Log in: **admin** / **admin**
3. Click **Dashboards** in the left sidebar
4. Open **Notification Service**

The dashboard has three sections:

| Section | Panels |
|---------|--------|
| **Evaluations** | Decision rate (allow vs deny), Deny reasons breakdown |
| **HTTP Performance** | Request rate by route, Latency percentiles (p50 / p95 / p99) |
| **Cache Performance** | Cache hit rate by key type, Cache operations rate |

Panels use `rate([5m])` — they need traffic to show data. Generate it with:

```bash
npm run load                   # 6 rounds, ~70 requests each
ROUNDS=20 npm run load         # more data points
```

If panels show "No data" after switching the time range to **Last 15 minutes**, wait one Prometheus scrape cycle (15 s) and refresh.

---

## Scaling

### Multiple replicas

Nginx is included in the Docker Compose stack and load-balances across all app containers using Docker's internal DNS (round-robin). The app containers are not exposed directly to the host — all traffic goes through Nginx on port 3000.

```bash
# Start with 3 replicas (Nginx load-balances automatically)
docker compose up --scale app=3 -d

# Scale back down at any time
docker compose up --scale app=1 -d
```

The app is stateless: all persistent state lives in PostgreSQL and Redis, so every replica always serves the same data.

### Verifying statelessness (e2e scaling tests)

```bash
# With 3 replicas already running:
npm run test:e2e
```

The `tests/e2e/scaling.test.ts` suite fires 10–20 concurrent requests after each write and asserts that every response reflects the latest data, regardless of which replica handled it.

### Kubernetes checklist

- `GET /healthz` → `livenessProbe`
- `GET /readyz` → `readinessProbe`
- Config via `ConfigMap` / `Secret` (environment variables)
- Replace Nginx with a k8s `Service` (type `ClusterIP` + `Ingress`)
- PgBouncer as a sidecar or dedicated Deployment (profile already in `docker-compose.yml`)
- Redis → Redis Sentinel or Redis Cluster for HA
- `HorizontalPodAutoscaler` on CPU or custom metric

### PgBouncer (optional, already configured)

```bash
# Start the stack with PgBouncer in front of Postgres
docker compose --profile pgbouncer up -d

# Point the app at PgBouncer (port 6432)
DATABASE_URL=postgresql://postgres:postgres@localhost:6432/notifications
```

---

## License

MIT License — see [LICENSE](./LICENSE) for details.
