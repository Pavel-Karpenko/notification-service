import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EvaluationService } from '../../../src/domain/services/EvaluationService';
import { IUserPreferenceRepository } from '../../../src/domain/repositories/IUserPreferenceRepository';
import { IGlobalPolicyRepository } from '../../../src/domain/repositories/IGlobalPolicyRepository';
import { IDefaultPreferenceRepository } from '../../../src/domain/repositories/IDefaultPreferenceRepository';
import { ICache } from '../../../src/infrastructure/cache/RedisCache';
import { UserPreference } from '../../../src/domain/entities/UserPreference';
import { GlobalPolicy } from '../../../src/domain/entities/GlobalPolicy';
import { DefaultPreference } from '../../../src/domain/entities/DefaultPreference';
import { QuietHours } from '../../../src/domain/entities/QuietHours';

function makeMockCache(): ICache {
  return {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue(undefined),
    del: vi.fn().mockResolvedValue(undefined),
  };
}

function makeMockUserPrefs(overrides: Partial<IUserPreferenceRepository> = {}): IUserPreferenceRepository {
  return {
    findByUserId: vi.fn().mockResolvedValue([]),
    findOne: vi.fn().mockResolvedValue(null),
    upsert: vi.fn(),
    findQuietHours: vi.fn().mockResolvedValue(null),
    upsertQuietHours: vi.fn(),
    ...overrides,
  };
}

function makeMockGlobalPolicies(overrides: Partial<IGlobalPolicyRepository> = {}): IGlobalPolicyRepository {
  return {
    findBlocking: vi.fn().mockResolvedValue(null),
    findAll: vi.fn().mockResolvedValue([]),
    upsert: vi.fn(),
    ...overrides,
  };
}

function makeMockDefaultPrefs(overrides: Partial<IDefaultPreferenceRepository> = {}): IDefaultPreferenceRepository {
  return {
    findAll: vi.fn().mockResolvedValue([]),
    findOne: vi.fn().mockResolvedValue(null),
    ...overrides,
  };
}

const BASE_INPUT = {
  userId: 'user-1',
  notificationType: 'marketing_email' as const,
  channel: 'email' as const,
  region: 'EU',
  datetime: new Date('2026-05-21T10:00:00Z'),
};

describe('EvaluationService', () => {
  describe('Scenario 1: New user gets default preferences', () => {
    it('should allow when default is enabled and no user override', async () => {
      const defaultPrefs = makeMockDefaultPrefs({
        findOne: vi.fn().mockResolvedValue({
          notificationType: 'marketing_email',
          channel: 'email',
          enabled: true,
        } satisfies DefaultPreference),
      });

      const service = new EvaluationService(
        makeMockUserPrefs(),
        makeMockGlobalPolicies(),
        defaultPrefs,
        makeMockCache(),
      );

      const result = await service.evaluate(BASE_INPUT);
      expect(result).toEqual({ decision: 'allow', reason: 'default_preference' });
    });

    it('should deny when default is disabled and no user override', async () => {
      const defaultPrefs = makeMockDefaultPrefs({
        findOne: vi.fn().mockResolvedValue({
          notificationType: 'marketing_email',
          channel: 'email',
          enabled: false,
        } satisfies DefaultPreference),
      });

      const service = new EvaluationService(
        makeMockUserPrefs(),
        makeMockGlobalPolicies(),
        defaultPrefs,
        makeMockCache(),
      );

      const result = await service.evaluate(BASE_INPUT);
      expect(result).toEqual({ decision: 'deny', reason: 'default_preference' });
    });
  });

  describe('Scenario 2: User disabled marketing_email → deny', () => {
    it('should deny when user has explicitly disabled the preference', async () => {
      const userPrefs = makeMockUserPrefs({
        findByUserId: vi.fn().mockResolvedValue([
          {
            userId: 'user-1',
            notificationType: 'marketing_email',
            channel: 'email',
            enabled: false,
            updatedAt: new Date(),
          } satisfies UserPreference,
        ]),
      });

      const service = new EvaluationService(
        userPrefs,
        makeMockGlobalPolicies(),
        makeMockDefaultPrefs(),
        makeMockCache(),
      );

      const result = await service.evaluate(BASE_INPUT);
      expect(result).toEqual({ decision: 'deny', reason: 'disabled_by_user' });
    });
  });

  describe('Scenario 3: Quiet hours blocks marketing_push', () => {
    it('should deny when datetime falls in quiet hours window', async () => {
      const quietHours: QuietHours = {
        userId: 'user-1',
        startHour: 22,
        startMinute: 0,
        endHour: 8,
        endMinute: 0,
        timezone: 'UTC',
        updatedAt: new Date(),
      };

      const userPrefs = makeMockUserPrefs({
        findByUserId: vi.fn().mockResolvedValue([]),
        findQuietHours: vi.fn().mockResolvedValue(quietHours),
      });

      const defaultPrefs = makeMockDefaultPrefs({
        findOne: vi.fn().mockResolvedValue({
          notificationType: 'marketing_push',
          channel: 'push',
          enabled: true,
        } satisfies DefaultPreference),
      });

      const service = new EvaluationService(
        userPrefs,
        makeMockGlobalPolicies(),
        defaultPrefs,
        makeMockCache(),
      );

      // 23:00 UTC — within quiet hours
      const result = await service.evaluate({
        userId: 'user-1',
        notificationType: 'marketing_push',
        channel: 'push',
        region: 'EU',
        datetime: new Date('2026-05-21T23:00:00Z'),
      });

      expect(result).toEqual({ decision: 'deny', reason: 'quiet_hours' });
    });
  });

  describe('Scenario 4: Transactional bypasses quiet hours', () => {
    it('should allow transactional notification even during quiet hours', async () => {
      const quietHours: QuietHours = {
        userId: 'user-1',
        startHour: 22,
        startMinute: 0,
        endHour: 8,
        endMinute: 0,
        timezone: 'UTC',
        updatedAt: new Date(),
      };

      const userPrefs = makeMockUserPrefs({
        findByUserId: vi.fn().mockResolvedValue([]),
        findQuietHours: vi.fn().mockResolvedValue(quietHours),
      });

      const defaultPrefs = makeMockDefaultPrefs({
        findOne: vi.fn().mockResolvedValue({
          notificationType: 'transactional_push',
          channel: 'push',
          enabled: true,
        } satisfies DefaultPreference),
      });

      const service = new EvaluationService(
        userPrefs,
        makeMockGlobalPolicies(),
        defaultPrefs,
        makeMockCache(),
      );

      // 23:00 UTC — during quiet hours, but transactional
      const result = await service.evaluate({
        userId: 'user-1',
        notificationType: 'transactional_push',
        channel: 'push',
        region: 'EU',
        datetime: new Date('2026-05-21T23:00:00Z'),
      });

      expect(result).toEqual({ decision: 'allow', reason: 'default_preference' });
    });
  });

  describe('Scenario 5: Global policy blocks marketing_sms in EU', () => {
    it('should deny when a global deny policy exists for the region', async () => {
      const policy: GlobalPolicy = {
        id: 'policy-1',
        notificationType: 'marketing_sms',
        channel: 'sms',
        region: 'EU',
        action: 'deny',
        createdAt: new Date(),
      };

      const globalPolicies = makeMockGlobalPolicies({
        findBlocking: vi.fn().mockResolvedValue(policy),
      });

      const service = new EvaluationService(
        makeMockUserPrefs(),
        globalPolicies,
        makeMockDefaultPrefs(),
        makeMockCache(),
      );

      const result = await service.evaluate({
        userId: 'user-1',
        notificationType: 'marketing_sms',
        channel: 'sms',
        region: 'EU',
        datetime: new Date('2026-05-21T10:00:00Z'),
      });

      expect(result).toEqual({ decision: 'deny', reason: 'blocked_by_global_policy' });
    });

    it('should allow for different region without policy', async () => {
      const globalPolicies = makeMockGlobalPolicies({
        findBlocking: vi.fn().mockResolvedValue(null),
      });

      const defaultPrefs = makeMockDefaultPrefs({
        findOne: vi.fn().mockResolvedValue({
          notificationType: 'marketing_sms',
          channel: 'sms',
          enabled: true,
        } satisfies DefaultPreference),
      });

      const service = new EvaluationService(
        makeMockUserPrefs(),
        globalPolicies,
        defaultPrefs,
        makeMockCache(),
      );

      const result = await service.evaluate({
        userId: 'user-1',
        notificationType: 'marketing_sms',
        channel: 'sms',
        region: 'US',
        datetime: new Date('2026-05-21T10:00:00Z'),
      });

      expect(result).toEqual({ decision: 'allow', reason: 'default_preference' });
    });
  });

  describe('Scenario 6: Idempotency — double upsert same result', () => {
    it('should return the same result when evaluated twice with same inputs', async () => {
      const userPrefs = makeMockUserPrefs({
        findByUserId: vi.fn().mockResolvedValue([
          {
            userId: 'user-1',
            notificationType: 'marketing_email',
            channel: 'email',
            enabled: true,
            updatedAt: new Date(),
          } satisfies UserPreference,
        ]),
      });

      const service = new EvaluationService(
        userPrefs,
        makeMockGlobalPolicies(),
        makeMockDefaultPrefs(),
        makeMockCache(),
      );

      const result1 = await service.evaluate(BASE_INPUT);
      const result2 = await service.evaluate(BASE_INPUT);

      expect(result1).toEqual(result2);
      expect(result1).toEqual({ decision: 'allow', reason: 'user_preference' });
    });
  });

  describe('Cache behavior', () => {
    it('should use cached values when available', async () => {
      const cachedPrefs = [
        { notificationType: 'marketing_email', channel: 'email', enabled: false },
      ];

      const cache: ICache = {
        get: vi.fn().mockImplementation((key: string) => {
          if (key.startsWith('prefs:')) return Promise.resolve(cachedPrefs);
          if (key.startsWith('quiet:')) return Promise.resolve(false);
          if (key.startsWith('policy:')) return Promise.resolve({ blocking: false });
          return Promise.resolve(null);
        }),
        set: vi.fn().mockResolvedValue(undefined),
        del: vi.fn().mockResolvedValue(undefined),
      };

      const userPrefsRepo = makeMockUserPrefs();

      const service = new EvaluationService(
        userPrefsRepo,
        makeMockGlobalPolicies(),
        makeMockDefaultPrefs(),
        cache,
      );

      const result = await service.evaluate(BASE_INPUT);
      expect(result).toEqual({ decision: 'deny', reason: 'disabled_by_user' });

      // DB should not be called since cache was hit
      expect(userPrefsRepo.findByUserId).not.toHaveBeenCalled();
    });
  });
});
