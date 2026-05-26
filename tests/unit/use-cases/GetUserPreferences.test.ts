import { describe, it, expect, vi } from 'vitest';
import { GetUserPreferences } from '../../../src/application/use-cases/GetUserPreferences';
import { IUserPreferenceRepository } from '../../../src/domain/repositories/IUserPreferenceRepository';
import { IDefaultPreferenceRepository } from '../../../src/domain/repositories/IDefaultPreferenceRepository';
import { ICache } from '../../../src/infrastructure/cache/RedisCache';
import { UserPreference } from '../../../src/domain/entities/UserPreference';
import { DefaultPreference } from '../../../src/domain/entities/DefaultPreference';
import { QuietHours } from '../../../src/domain/entities/QuietHours';

// Seeded defaults matching migrations/0001_initial.sql
const SEEDED_DEFAULTS: DefaultPreference[] = [
  { notificationType: 'transactional_email', channel: 'email', enabled: true },
  { notificationType: 'marketing_email', channel: 'email', enabled: false },
  { notificationType: 'transactional_sms', channel: 'sms', enabled: true },
  { notificationType: 'marketing_sms', channel: 'sms', enabled: false },
  { notificationType: 'transactional_push', channel: 'push', enabled: true },
  { notificationType: 'marketing_push', channel: 'push', enabled: false },
];

function mockUserPrefs(overrides: Partial<IUserPreferenceRepository> = {}): IUserPreferenceRepository {
  return {
    findByUserId: vi.fn().mockResolvedValue([]),
    findOne: vi.fn().mockResolvedValue(null),
    upsert: vi.fn(),
    findQuietHours: vi.fn().mockResolvedValue(null),
    upsertQuietHours: vi.fn(),
    ...overrides,
  };
}

function mockDefaultPrefs(prefs = SEEDED_DEFAULTS): IDefaultPreferenceRepository {
  return {
    findAll: vi.fn().mockResolvedValue(prefs),
    findOne: vi.fn(),
  };
}

function noopCache(): ICache {
  return {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue(undefined),
    del: vi.fn().mockResolvedValue(undefined),
  };
}

describe('GetUserPreferences', () => {
  describe('ТЗ Сценарий 1: Новый пользователь получает дефолтные настройки', () => {
    it('returns all defaults with source="default" when user has no explicit preferences', async () => {
      const useCase = new GetUserPreferences(
        mockUserPrefs(),
        mockDefaultPrefs(),
        noopCache(),
      );

      const result = await useCase.execute('new-user');

      expect(result.userId).toBe('new-user');
      expect(result.preferences).toHaveLength(SEEDED_DEFAULTS.length);
      expect(result.preferences.every((p) => p.source === 'default')).toBe(true);
    });

    it('returns transactional_email enabled by default', async () => {
      const useCase = new GetUserPreferences(mockUserPrefs(), mockDefaultPrefs(), noopCache());
      const result = await useCase.execute('new-user');

      const pref = result.preferences.find(
        (p) => p.notificationType === 'transactional_email' && p.channel === 'email',
      );
      expect(pref?.enabled).toBe(true);
      expect(pref?.source).toBe('default');
    });

    it('returns marketing_email disabled by default', async () => {
      const useCase = new GetUserPreferences(mockUserPrefs(), mockDefaultPrefs(), noopCache());
      const result = await useCase.execute('new-user');

      const pref = result.preferences.find(
        (p) => p.notificationType === 'marketing_email' && p.channel === 'email',
      );
      expect(pref?.enabled).toBe(false);
      expect(pref?.source).toBe('default');
    });

    it('returns null quietHours for new user', async () => {
      const useCase = new GetUserPreferences(mockUserPrefs(), mockDefaultPrefs(), noopCache());
      const result = await useCase.execute('new-user');

      expect(result.quietHours).toBeNull();
    });
  });

  describe('ТЗ Сценарий 2: Изменения настроек отражаются в ответе', () => {
    it('overrides default with user preference and sets source="user"', async () => {
      const userPrefsRepo = mockUserPrefs({
        findByUserId: vi.fn().mockResolvedValue([
          {
            userId: 'user-1',
            notificationType: 'marketing_email',
            channel: 'email',
            enabled: true, // user overrode the disabled default
            updatedAt: new Date(),
          } satisfies UserPreference,
        ]),
      });

      const useCase = new GetUserPreferences(userPrefsRepo, mockDefaultPrefs(), noopCache());
      const result = await useCase.execute('user-1');

      const pref = result.preferences.find(
        (p) => p.notificationType === 'marketing_email' && p.channel === 'email',
      );
      expect(pref?.enabled).toBe(true);
      expect(pref?.source).toBe('user');
    });

    it('leaves other preferences as defaults when only one is overridden', async () => {
      const userPrefsRepo = mockUserPrefs({
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

      const useCase = new GetUserPreferences(userPrefsRepo, mockDefaultPrefs(), noopCache());
      const result = await useCase.execute('user-1');

      // transactional_email should still be from default
      const transactional = result.preferences.find(
        (p) => p.notificationType === 'transactional_email' && p.channel === 'email',
      );
      expect(transactional?.source).toBe('default');
      expect(transactional?.enabled).toBe(true);
    });

    it('applies multiple user overrides simultaneously', async () => {
      const userOverrides: UserPreference[] = [
        { userId: 'u1', notificationType: 'marketing_email', channel: 'email', enabled: true, updatedAt: new Date() },
        { userId: 'u1', notificationType: 'transactional_sms', channel: 'sms', enabled: false, updatedAt: new Date() },
      ];

      const useCase = new GetUserPreferences(
        mockUserPrefs({ findByUserId: vi.fn().mockResolvedValue(userOverrides) }),
        mockDefaultPrefs(),
        noopCache(),
      );

      const result = await useCase.execute('u1');

      const marketingEmail = result.preferences.find(
        (p) => p.notificationType === 'marketing_email' && p.channel === 'email',
      );
      expect(marketingEmail).toMatchObject({ enabled: true, source: 'user' });

      const transactionalSms = result.preferences.find(
        (p) => p.notificationType === 'transactional_sms' && p.channel === 'sms',
      );
      expect(transactionalSms).toMatchObject({ enabled: false, source: 'user' });
    });
  });

  describe('Quiet hours in response', () => {
    it('returns quietHours when user has them configured', async () => {
      const qh: QuietHours = {
        userId: 'user-1',
        startHour: 22,
        startMinute: 0,
        endHour: 8,
        endMinute: 0,
        timezone: 'Europe/Berlin',
        updatedAt: new Date(),
      };

      const useCase = new GetUserPreferences(
        mockUserPrefs({ findQuietHours: vi.fn().mockResolvedValue(qh) }),
        mockDefaultPrefs(),
        noopCache(),
      );

      const result = await useCase.execute('user-1');

      expect(result.quietHours).toEqual({
        startHour: 22,
        startMinute: 0,
        endHour: 8,
        endMinute: 0,
        timezone: 'Europe/Berlin',
      });
    });
  });

  describe('Cache behaviour', () => {
    it('caches user preferences after DB lookup', async () => {
      const cache = noopCache();

      const useCase = new GetUserPreferences(
        mockUserPrefs({ findByUserId: vi.fn().mockResolvedValue([]) }),
        mockDefaultPrefs(),
        cache,
      );

      await useCase.execute('user-1');

      expect(cache.set).toHaveBeenCalledWith(
        'prefs:user-1',
        expect.any(Array),
        60,
      );
    });

    it('uses cached preferences and skips DB lookup', async () => {
      const userPrefsRepo = mockUserPrefs();
      const cache: ICache = {
        get: vi.fn().mockImplementation((key: string) => {
          if (key === 'prefs:user-1') return Promise.resolve([
            { notificationType: 'marketing_email', channel: 'email', enabled: true },
          ]);
          if (key === 'quiet:user-1') return Promise.resolve(false);
          return Promise.resolve(null);
        }),
        set: vi.fn().mockResolvedValue(undefined),
        del: vi.fn().mockResolvedValue(undefined),
      };

      const useCase = new GetUserPreferences(userPrefsRepo, mockDefaultPrefs(), cache);
      const result = await useCase.execute('user-1');

      expect(userPrefsRepo.findByUserId).not.toHaveBeenCalled();

      const pref = result.preferences.find(
        (p) => p.notificationType === 'marketing_email' && p.channel === 'email',
      );
      expect(pref).toMatchObject({ enabled: true, source: 'user' });
    });

    it('treats cached false as "no quiet hours" without DB call', async () => {
      const userPrefsRepo = mockUserPrefs();
      const cache: ICache = {
        get: vi.fn().mockImplementation((key: string) => {
          if (key.startsWith('prefs:')) return Promise.resolve([]);
          if (key.startsWith('quiet:')) return Promise.resolve(false);
          return Promise.resolve(null);
        }),
        set: vi.fn().mockResolvedValue(undefined),
        del: vi.fn().mockResolvedValue(undefined),
      };

      const useCase = new GetUserPreferences(userPrefsRepo, mockDefaultPrefs(), cache);
      const result = await useCase.execute('user-1');

      expect(userPrefsRepo.findQuietHours).not.toHaveBeenCalled();
      expect(result.quietHours).toBeNull();
    });

    it('caches "false" sentinel when no quiet hours found in DB', async () => {
      const cache = noopCache();

      const useCase = new GetUserPreferences(
        mockUserPrefs({ findQuietHours: vi.fn().mockResolvedValue(null) }),
        mockDefaultPrefs(),
        cache,
      );

      await useCase.execute('user-1');

      expect(cache.set).toHaveBeenCalledWith('quiet:user-1', false, 60);
    });
  });

  describe('Empty defaults edge case', () => {
    it('returns empty preferences when no defaults are configured', async () => {
      const useCase = new GetUserPreferences(
        mockUserPrefs(),
        mockDefaultPrefs([]),
        noopCache(),
      );

      const result = await useCase.execute('new-user');
      expect(result.preferences).toHaveLength(0);
    });
  });
});
