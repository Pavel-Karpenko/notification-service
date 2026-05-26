import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/infrastructure/metrics/prometheus', () => ({
  preferenceUpdatesTotal: { inc: vi.fn() },
  evaluationsTotal: { inc: vi.fn() },
  httpDuration: { observe: vi.fn() },
  cacheHitsTotal: { inc: vi.fn() },
  cacheMissesTotal: { inc: vi.fn() },
  registry: { metrics: vi.fn().mockResolvedValue(''), contentType: 'text/plain' },
  collectDefaultMetrics: vi.fn(),
}));

import { UpdateUserPreferences } from '../../../src/application/use-cases/UpdateUserPreferences';
import { IUserPreferenceRepository } from '../../../src/domain/repositories/IUserPreferenceRepository';
import { ICache } from '../../../src/infrastructure/cache/RedisCache';
import { UserPreference } from '../../../src/domain/entities/UserPreference';
import { QuietHours } from '../../../src/domain/entities/QuietHours';
import * as prometheus from '../../../src/infrastructure/metrics/prometheus';

function mockUserPrefsRepo(overrides: Partial<IUserPreferenceRepository> = {}): IUserPreferenceRepository {
  return {
    findByUserId: vi.fn().mockResolvedValue([]),
    findOne: vi.fn().mockResolvedValue(null),
    upsert: vi.fn().mockImplementation((pref) => Promise.resolve({ ...pref, updatedAt: new Date() })),
    findQuietHours: vi.fn().mockResolvedValue(null),
    upsertQuietHours: vi.fn().mockImplementation((qh) => Promise.resolve({ ...qh, updatedAt: new Date() })),
    ...overrides,
  };
}

function mockCache(): ICache {
  return {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue(undefined),
    del: vi.fn().mockResolvedValue(undefined),
  };
}

describe('UpdateUserPreferences', () => {
  describe('ТЗ Сценарий 2: Пользователь меняет настройки', () => {
    it('upserts a single preference and returns it', async () => {
      const repo = mockUserPrefsRepo();
      const useCase = new UpdateUserPreferences(repo, mockCache());

      const result = await useCase.execute({
        userId: 'user-1',
        preferences: [{ notificationType: 'marketing_email', channel: 'email', enabled: false }],
      });

      expect(repo.upsert).toHaveBeenCalledOnce();
      expect(repo.upsert).toHaveBeenCalledWith({
        userId: 'user-1',
        notificationType: 'marketing_email',
        channel: 'email',
        enabled: false,
      });
      expect(result.updatedPreferences).toHaveLength(1);
    });

    it('upserts multiple preferences in order', async () => {
      const repo = mockUserPrefsRepo();
      const useCase = new UpdateUserPreferences(repo, mockCache());

      await useCase.execute({
        userId: 'user-1',
        preferences: [
          { notificationType: 'marketing_email', channel: 'email', enabled: false },
          { notificationType: 'transactional_email', channel: 'email', enabled: true },
          { notificationType: 'marketing_push', channel: 'push', enabled: false },
        ],
      });

      expect(repo.upsert).toHaveBeenCalledTimes(3);
    });

    it('returns updated preferences with correct values', async () => {
      const updatedPref: UserPreference = {
        userId: 'user-1',
        notificationType: 'marketing_email',
        channel: 'email',
        enabled: false,
        updatedAt: new Date(),
      };

      const repo = mockUserPrefsRepo({ upsert: vi.fn().mockResolvedValue(updatedPref) });
      const useCase = new UpdateUserPreferences(repo, mockCache());

      const result = await useCase.execute({
        userId: 'user-1',
        preferences: [{ notificationType: 'marketing_email', channel: 'email', enabled: false }],
      });

      expect(result.updatedPreferences[0]).toMatchObject({
        notificationType: 'marketing_email',
        channel: 'email',
        enabled: false,
      });
    });
  });

  describe('ТЗ Сценарий 3: Quiet hours', () => {
    it('saves quiet hours and returns them', async () => {
      const savedQh: QuietHours = {
        userId: 'user-1',
        startHour: 22,
        startMinute: 0,
        endHour: 8,
        endMinute: 0,
        timezone: 'Europe/Berlin',
        updatedAt: new Date(),
      };

      const repo = mockUserPrefsRepo({ upsertQuietHours: vi.fn().mockResolvedValue(savedQh) });
      const useCase = new UpdateUserPreferences(repo, mockCache());

      const result = await useCase.execute({
        userId: 'user-1',
        quietHours: {
          startHour: 22,
          startMinute: 0,
          endHour: 8,
          endMinute: 0,
          timezone: 'Europe/Berlin',
        },
      });

      expect(repo.upsertQuietHours).toHaveBeenCalledWith({
        userId: 'user-1',
        startHour: 22,
        startMinute: 0,
        endHour: 8,
        endMinute: 0,
        timezone: 'Europe/Berlin',
      });
      expect(result.quietHours).toEqual({
        startHour: 22,
        startMinute: 0,
        endHour: 8,
        endMinute: 0,
        timezone: 'Europe/Berlin',
      });
    });

    it('updates both preferences and quiet hours in one call', async () => {
      const repo = mockUserPrefsRepo();
      const useCase = new UpdateUserPreferences(repo, mockCache());

      const result = await useCase.execute({
        userId: 'user-1',
        preferences: [{ notificationType: 'marketing_email', channel: 'email', enabled: false }],
        quietHours: {
          startHour: 22,
          startMinute: 0,
          endHour: 8,
          endMinute: 0,
          timezone: 'UTC',
        },
      });

      expect(repo.upsert).toHaveBeenCalledOnce();
      expect(repo.upsertQuietHours).toHaveBeenCalledOnce();
      expect(result.updatedPreferences).toHaveLength(1);
      expect(result.quietHours).not.toBeNull();
    });
  });

  describe('ТЗ Сценарий 5: Идемпотентность', () => {
    it('calls upsert twice when preferences array has duplicate entries', async () => {
      const repo = mockUserPrefsRepo();
      const useCase = new UpdateUserPreferences(repo, mockCache());

      // First call
      await useCase.execute({
        userId: 'user-1',
        preferences: [{ notificationType: 'marketing_email', channel: 'email', enabled: false }],
      });

      // Second identical call
      await useCase.execute({
        userId: 'user-1',
        preferences: [{ notificationType: 'marketing_email', channel: 'email', enabled: false }],
      });

      // upsert called twice total (ON CONFLICT DO UPDATE ensures idempotency at DB level)
      expect(repo.upsert).toHaveBeenCalledTimes(2);
    });

    it('returns null quietHours when not included in input', async () => {
      const repo = mockUserPrefsRepo();
      const useCase = new UpdateUserPreferences(repo, mockCache());

      const result = await useCase.execute({
        userId: 'user-1',
        preferences: [{ notificationType: 'marketing_email', channel: 'email', enabled: false }],
        // no quietHours
      });

      expect(result.quietHours).toBeNull();
      expect(repo.upsertQuietHours).not.toHaveBeenCalled();
    });
  });

  describe('Cache invalidation', () => {
    it('invalidates prefs cache after update', async () => {
      const cache = mockCache();
      const useCase = new UpdateUserPreferences(mockUserPrefsRepo(), cache);

      await useCase.execute({
        userId: 'user-42',
        preferences: [{ notificationType: 'marketing_email', channel: 'email', enabled: false }],
      });

      expect(cache.del).toHaveBeenCalledWith('prefs:user-42');
    });

    it('invalidates quiet hours cache after update', async () => {
      const cache = mockCache();
      const useCase = new UpdateUserPreferences(mockUserPrefsRepo(), cache);

      await useCase.execute({
        userId: 'user-42',
        quietHours: { startHour: 22, startMinute: 0, endHour: 8, endMinute: 0, timezone: 'UTC' },
      });

      expect(cache.del).toHaveBeenCalledWith('quiet:user-42');
    });

    it('invalidates both cache keys when updating both prefs and quiet hours', async () => {
      const cache = mockCache();
      const useCase = new UpdateUserPreferences(mockUserPrefsRepo(), cache);

      await useCase.execute({
        userId: 'user-42',
        preferences: [{ notificationType: 'marketing_email', channel: 'email', enabled: false }],
        quietHours: { startHour: 22, startMinute: 0, endHour: 8, endMinute: 0, timezone: 'UTC' },
      });

      expect(cache.del).toHaveBeenCalledWith('prefs:user-42');
      expect(cache.del).toHaveBeenCalledWith('quiet:user-42');
    });
  });

  describe('Metrics', () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    it('increments preferenceUpdatesTotal for each updated preference', async () => {
      const useCase = new UpdateUserPreferences(mockUserPrefsRepo(), mockCache());

      await useCase.execute({
        userId: 'user-1',
        preferences: [
          { notificationType: 'marketing_email', channel: 'email', enabled: false },
          { notificationType: 'marketing_sms', channel: 'sms', enabled: false },
        ],
      });

      expect(prometheus.preferenceUpdatesTotal.inc).toHaveBeenCalledTimes(2);
      expect(prometheus.preferenceUpdatesTotal.inc).toHaveBeenCalledWith({
        notification_type: 'marketing_email',
        channel: 'email',
      });
      expect(prometheus.preferenceUpdatesTotal.inc).toHaveBeenCalledWith({
        notification_type: 'marketing_sms',
        channel: 'sms',
      });
    });

    it('does not increment metrics when no preferences are updated', async () => {
      const useCase = new UpdateUserPreferences(mockUserPrefsRepo(), mockCache());

      await useCase.execute({
        userId: 'user-1',
        quietHours: { startHour: 22, startMinute: 0, endHour: 8, endMinute: 0, timezone: 'UTC' },
      });

      expect(prometheus.preferenceUpdatesTotal.inc).not.toHaveBeenCalled();
    });
  });

  describe('Edge cases', () => {
    it('handles empty preferences array gracefully', async () => {
      const repo = mockUserPrefsRepo();
      const useCase = new UpdateUserPreferences(repo, mockCache());

      const result = await useCase.execute({ userId: 'user-1', preferences: [] });

      expect(repo.upsert).not.toHaveBeenCalled();
      expect(result.updatedPreferences).toHaveLength(0);
    });

    it('handles undefined preferences (only quietHours provided)', async () => {
      const repo = mockUserPrefsRepo();
      const useCase = new UpdateUserPreferences(repo, mockCache());

      const result = await useCase.execute({
        userId: 'user-1',
        quietHours: { startHour: 9, startMinute: 0, endHour: 17, endMinute: 0, timezone: 'UTC' },
      });

      expect(repo.upsert).not.toHaveBeenCalled();
      expect(result.updatedPreferences).toHaveLength(0);
      expect(result.quietHours).not.toBeNull();
    });
  });
});
