import Redis from 'ioredis';
import { cacheHitsTotal, cacheMissesTotal } from '../metrics/prometheus';

export interface ICache {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T, ttlSeconds: number): Promise<void>;
  del(key: string): Promise<void>;
}

export class RedisCache implements ICache {
  constructor(private readonly client: Redis) {}

  async get<T>(key: string): Promise<T | null> {
    const keyType = this.extractKeyType(key);
    const raw = await this.client.get(key);
    if (raw === null) {
      cacheMissesTotal.inc({ key_type: keyType });
      return null;
    }
    cacheHitsTotal.inc({ key_type: keyType });
    return JSON.parse(raw) as T;
  }

  async set<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
    await this.client.set(key, JSON.stringify(value), 'EX', ttlSeconds);
  }

  async del(key: string): Promise<void> {
    await this.client.del(key);
  }

  private extractKeyType(key: string): string {
    const colonIndex = key.indexOf(':');
    return colonIndex !== -1 ? key.substring(0, colonIndex) : key;
  }
}

export class NoopCache implements ICache {
  async get<T>(_key: string): Promise<T | null> {
    return null;
  }

  async set<T>(_key: string, _value: T, _ttlSeconds: number): Promise<void> {
    // noop
  }

  async del(_key: string): Promise<void> {
    // noop
  }
}
