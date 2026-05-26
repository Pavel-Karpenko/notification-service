import { Registry, Counter, Histogram, collectDefaultMetrics } from 'prom-client';

export const registry = new Registry();

collectDefaultMetrics({ register: registry });

export const evaluationsTotal = new Counter({
  name: 'notifications_evaluated_total',
  help: 'Total notification evaluations',
  labelNames: ['decision', 'notification_type', 'channel', 'reason'],
  registers: [registry],
});

export const httpDuration = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
  registers: [registry],
});

export const preferenceUpdatesTotal = new Counter({
  name: 'preference_updates_total',
  help: 'Total preference update operations',
  labelNames: ['notification_type', 'channel'],
  registers: [registry],
});

export const cacheHitsTotal = new Counter({
  name: 'cache_hits_total',
  help: 'Cache hits',
  labelNames: ['key_type'],
  registers: [registry],
});

export const cacheMissesTotal = new Counter({
  name: 'cache_misses_total',
  help: 'Cache misses',
  labelNames: ['key_type'],
  registers: [registry],
});
