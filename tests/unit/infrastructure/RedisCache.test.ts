import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/infrastructure/metrics/prometheus', () => ({
  cacheHitsTotal: { inc: vi.fn() },
  cacheMissesTotal: { inc: vi.fn() },
  evaluationsTotal: { inc: vi.fn() },
  preferenceUpdatesTotal: { inc: vi.fn() },
  httpDuration: { observe: vi.fn() },
  registry: { metrics: vi.fn().mockResolvedValue(''), contentType: 'text/plain' },
  collectDefaultMetrics: vi.fn(),
}));

import { RedisCache, NoopCache } from '../../../src/infrastructure/cache/RedisCache';
import * as prometheus from '../../../src/infrastructure/metrics/prometheus';
import type Redis from 'ioredis';

function makeMockRedis() {
  return {
    get: vi.fn(),
    set: vi.fn().mockResolvedValue('OK'),
    del: vi.fn().mockResolvedValue(1),
  } as unknown as Redis;
}

describe('RedisCache', () => {
  let redis: Redis;
  let cache: RedisCache;

  beforeEach(() => {
    vi.clearAllMocks();
    redis = makeMockRedis();
    cache = new RedisCache(redis);
  });

  describe('get()', () => {
    it('returns parsed JSON on cache hit', async () => {
      const data = { notificationType: 'marketing_email', enabled: false };
      (redis.get as ReturnType<typeof vi.fn>).mockResolvedValue(JSON.stringify(data));

      const result = await cache.get<typeof data>('prefs:user-1');

      expect(result).toEqual(data);
    });

    it('returns null on cache miss', async () => {
      (redis.get as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      const result = await cache.get('prefs:user-1');

      expect(result).toBeNull();
    });

    it('increments cacheHitsTotal on hit', async () => {
      (redis.get as ReturnType<typeof vi.fn>).mockResolvedValue(JSON.stringify({ v: 1 }));

      await cache.get('prefs:user-1');

      expect(prometheus.cacheHitsTotal.inc).toHaveBeenCalledOnce();
      expect(prometheus.cacheHitsTotal.inc).toHaveBeenCalledWith({ key_type: 'prefs' });
    });

    it('increments cacheMissesTotal on miss', async () => {
      (redis.get as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      await cache.get('prefs:user-1');

      expect(prometheus.cacheMissesTotal.inc).toHaveBeenCalledOnce();
      expect(prometheus.cacheMissesTotal.inc).toHaveBeenCalledWith({ key_type: 'prefs' });
    });

    it('extracts correct key_type for policy keys', async () => {
      (redis.get as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      await cache.get('policy:marketing_email:email:EU');

      expect(prometheus.cacheMissesTotal.inc).toHaveBeenCalledWith({ key_type: 'policy' });
    });

    it('extracts correct key_type for quiet keys', async () => {
      (redis.get as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      await cache.get('quiet:user-99');

      expect(prometheus.cacheMissesTotal.inc).toHaveBeenCalledWith({ key_type: 'quiet' });
    });

    it('uses full key as type when no colon present', async () => {
      (redis.get as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      await cache.get('someplainkey');

      expect(prometheus.cacheMissesTotal.inc).toHaveBeenCalledWith({ key_type: 'someplainkey' });
    });

    it('handles boolean false stored as JSON', async () => {
      (redis.get as ReturnType<typeof vi.fn>).mockResolvedValue(JSON.stringify(false));

      const result = await cache.get<false>('quiet:user-1');

      expect(result).toBe(false);
    });

    it('handles array stored as JSON', async () => {
      const data = [{ notificationType: 'marketing_email', channel: 'email', enabled: false }];
      (redis.get as ReturnType<typeof vi.fn>).mockResolvedValue(JSON.stringify(data));

      const result = await cache.get<typeof data>('prefs:user-1');

      expect(result).toEqual(data);
    });
  });

  describe('set()', () => {
    it('serializes value as JSON with EX TTL', async () => {
      const data = { blocking: true };

      await cache.set('policy:marketing_sms:sms:EU', data, 300);

      expect(redis.set).toHaveBeenCalledWith(
        'policy:marketing_sms:sms:EU',
        JSON.stringify(data),
        'EX',
        300,
      );
    });

    it('serializes false as JSON false', async () => {
      await cache.set('quiet:user-1', false, 60);

      expect(redis.set).toHaveBeenCalledWith('quiet:user-1', 'false', 'EX', 60);
    });

    it('serializes arrays correctly', async () => {
      const data = [{ notificationType: 'marketing_email', channel: 'email', enabled: false }];

      await cache.set('prefs:user-1', data, 60);

      expect(redis.set).toHaveBeenCalledWith(
        'prefs:user-1',
        JSON.stringify(data),
        'EX',
        60,
      );
    });
  });

  describe('del()', () => {
    it('calls redis.del with the key', async () => {
      await cache.del('prefs:user-1');

      expect(redis.del).toHaveBeenCalledWith('prefs:user-1');
    });
  });
});

describe('NoopCache', () => {
  const cache = new NoopCache();

  it('get() always returns null', async () => {
    expect(await cache.get('any-key')).toBeNull();
  });

  it('set() resolves without throwing', async () => {
    await expect(cache.set('key', { data: 1 }, 60)).resolves.toBeUndefined();
  });

  it('del() resolves without throwing', async () => {
    await expect(cache.del('key')).resolves.toBeUndefined();
  });
});
