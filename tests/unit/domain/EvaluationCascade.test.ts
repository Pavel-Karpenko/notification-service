/**
 * Cascade priority tests: global_policy > user_disabled > quiet_hours > user_enabled > default
 *
 * These tests verify that higher-priority rules always override lower-priority rules,
 * covering edge cases not explicitly tested in EvaluationService.test.ts.
 */
import { describe, it, expect, vi } from 'vitest';
import { EvaluationService } from '../../../src/domain/services/EvaluationService';
import { IUserPreferenceRepository } from '../../../src/domain/repositories/IUserPreferenceRepository';
import { IGlobalPolicyRepository } from '../../../src/domain/repositories/IGlobalPolicyRepository';
import { IDefaultPreferenceRepository } from '../../../src/domain/repositories/IDefaultPreferenceRepository';
import { ICache } from '../../../src/infrastructure/cache/RedisCache';
import { UserPreference } from '../../../src/domain/entities/UserPreference';
import { GlobalPolicy } from '../../../src/domain/entities/GlobalPolicy';
import { DefaultPreference } from '../../../src/domain/entities/DefaultPreference';
import { QuietHours } from '../../../src/domain/entities/QuietHours';
import { NotificationType, Channel } from '../../../src/domain/types';

function noopCache(): ICache {
  return {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue(undefined),
    del: vi.fn().mockResolvedValue(undefined),
  };
}

function userPrefsRepo(prefs: UserPreference[] = [], qh: QuietHours | null = null): IUserPreferenceRepository {
  return {
    findByUserId: vi.fn().mockResolvedValue(prefs),
    findOne: vi.fn().mockResolvedValue(null),
    upsert: vi.fn(),
    findQuietHours: vi.fn().mockResolvedValue(qh),
    upsertQuietHours: vi.fn(),
  };
}

function globalPoliciesRepo(policy: GlobalPolicy | null = null): IGlobalPolicyRepository {
  return {
    findBlocking: vi.fn().mockResolvedValue(policy),
    findAll: vi.fn().mockResolvedValue([]),
    upsert: vi.fn(),
  };
}

function defaultPrefsRepo(prefs: DefaultPreference[] = []): IDefaultPreferenceRepository {
  return {
    findAll: vi.fn().mockResolvedValue(prefs),
    findOne: vi.fn().mockImplementation((type: NotificationType, channel: Channel) => {
      return Promise.resolve(prefs.find((p) => p.notificationType === type && p.channel === channel) ?? null);
    }),
  };
}

function buildService(
  userPrefs: IUserPreferenceRepository,
  globalPolicies: IGlobalPolicyRepository,
  defaultPrefs: IDefaultPreferenceRepository,
  cache: ICache = noopCache(),
) {
  return new EvaluationService(userPrefs, globalPolicies, defaultPrefs, cache);
}

const QUIET_HOURS: QuietHours = {
  userId: 'user-1',
  startHour: 22,
  startMinute: 0,
  endHour: 8,
  endMinute: 0,
  timezone: 'UTC',
  updatedAt: new Date(),
};

const BLOCKING_POLICY: GlobalPolicy = {
  id: 'p1',
  notificationType: 'marketing_email',
  channel: 'email',
  region: 'EU',
  action: 'deny',
  createdAt: new Date(),
};

const IN_QUIET_HOURS = new Date('2026-05-21T23:30:00Z'); // 23:30 UTC
const OUT_OF_QUIET_HOURS = new Date('2026-05-21T12:00:00Z'); // 12:00 UTC

describe('Cascade step 1 vs step 4: global_policy overrides user_enabled', () => {
  it('denies even when user has explicitly enabled the notification type', async () => {
    const service = buildService(
      userPrefsRepo([{ userId: 'user-1', notificationType: 'marketing_email', channel: 'email', enabled: true, updatedAt: new Date() }]),
      globalPoliciesRepo(BLOCKING_POLICY),
      defaultPrefsRepo([{ notificationType: 'marketing_email', channel: 'email', enabled: false }]),
    );

    const result = await service.evaluate({
      userId: 'user-1',
      notificationType: 'marketing_email',
      channel: 'email',
      region: 'EU',
      datetime: OUT_OF_QUIET_HOURS,
    });

    expect(result).toEqual({ decision: 'deny', reason: 'blocked_by_global_policy' });
  });
});

describe('Cascade step 2 vs step 3: user_disabled checked before quiet_hours', () => {
  it('denies with disabled_by_user reason (not quiet_hours) even during quiet hours', async () => {
    const service = buildService(
      userPrefsRepo(
        [{ userId: 'user-1', notificationType: 'marketing_push', channel: 'push', enabled: false, updatedAt: new Date() }],
        QUIET_HOURS,
      ),
      globalPoliciesRepo(),
      defaultPrefsRepo(),
    );

    const result = await service.evaluate({
      userId: 'user-1',
      notificationType: 'marketing_push',
      channel: 'push',
      region: 'US',
      datetime: IN_QUIET_HOURS,
    });

    // user_disabled (step 2) wins before quiet_hours (step 3)
    expect(result).toEqual({ decision: 'deny', reason: 'disabled_by_user' });
  });
});

describe('Cascade step 3 vs step 4: quiet_hours overrides user_enabled', () => {
  it('denies even when user has explicitly enabled, if quiet hours are active', async () => {
    const service = buildService(
      userPrefsRepo(
        [{ userId: 'user-1', notificationType: 'marketing_push', channel: 'push', enabled: true, updatedAt: new Date() }],
        QUIET_HOURS,
      ),
      globalPoliciesRepo(),
      defaultPrefsRepo(),
    );

    const result = await service.evaluate({
      userId: 'user-1',
      notificationType: 'marketing_push',
      channel: 'push',
      region: 'US',
      datetime: IN_QUIET_HOURS,
    });

    // quiet_hours (step 3) wins over user_enabled (step 4)
    expect(result).toEqual({ decision: 'deny', reason: 'quiet_hours' });
  });

  it('allows user_enabled when datetime is outside quiet hours', async () => {
    const service = buildService(
      userPrefsRepo(
        [{ userId: 'user-1', notificationType: 'marketing_push', channel: 'push', enabled: true, updatedAt: new Date() }],
        QUIET_HOURS,
      ),
      globalPoliciesRepo(),
      defaultPrefsRepo(),
    );

    const result = await service.evaluate({
      userId: 'user-1',
      notificationType: 'marketing_push',
      channel: 'push',
      region: 'US',
      datetime: OUT_OF_QUIET_HOURS,
    });

    expect(result).toEqual({ decision: 'allow', reason: 'user_preference' });
  });
});

describe('Cascade step 4 vs step 5: user_enabled overrides default', () => {
  it('allows when user enabled, even if default is disabled', async () => {
    const service = buildService(
      userPrefsRepo([{ userId: 'user-1', notificationType: 'marketing_email', channel: 'email', enabled: true, updatedAt: new Date() }]),
      globalPoliciesRepo(),
      defaultPrefsRepo([{ notificationType: 'marketing_email', channel: 'email', enabled: false }]),
    );

    const result = await service.evaluate({
      userId: 'user-1',
      notificationType: 'marketing_email',
      channel: 'email',
      region: 'US',
      datetime: OUT_OF_QUIET_HOURS,
    });

    expect(result).toEqual({ decision: 'allow', reason: 'user_preference' });
  });
});

describe('Cascade step 5: fallback to default', () => {
  it('allows when no user pref and default is enabled', async () => {
    const service = buildService(
      userPrefsRepo(),
      globalPoliciesRepo(),
      defaultPrefsRepo([{ notificationType: 'transactional_email', channel: 'email', enabled: true }]),
    );

    const result = await service.evaluate({
      userId: 'user-1',
      notificationType: 'transactional_email',
      channel: 'email',
      region: 'US',
      datetime: OUT_OF_QUIET_HOURS,
    });

    expect(result).toEqual({ decision: 'allow', reason: 'default_preference' });
  });

  it('denies when no user pref and default is disabled', async () => {
    const service = buildService(
      userPrefsRepo(),
      globalPoliciesRepo(),
      defaultPrefsRepo([{ notificationType: 'marketing_email', channel: 'email', enabled: false }]),
    );

    const result = await service.evaluate({
      userId: 'user-1',
      notificationType: 'marketing_email',
      channel: 'email',
      region: 'US',
      datetime: OUT_OF_QUIET_HOURS,
    });

    expect(result).toEqual({ decision: 'deny', reason: 'default_preference' });
  });

  it('denies when no user pref and no default exists', async () => {
    const service = buildService(
      userPrefsRepo(),
      globalPoliciesRepo(),
      defaultPrefsRepo([]),
    );

    const result = await service.evaluate({
      userId: 'user-1',
      notificationType: 'marketing_email',
      channel: 'email',
      region: 'US',
      datetime: OUT_OF_QUIET_HOURS,
    });

    expect(result).toEqual({ decision: 'deny', reason: 'default_preference' });
  });
});

describe('Transactional types bypass quiet hours (all 3 types)', () => {
  it.each([
    ['transactional_email', 'email'],
    ['transactional_sms', 'sms'],
    ['transactional_push', 'push'],
  ] as const)('%s on channel %s bypasses quiet hours', async (type, channel) => {
    const service = buildService(
      userPrefsRepo([], QUIET_HOURS),
      globalPoliciesRepo(),
      defaultPrefsRepo([{ notificationType: type, channel, enabled: true }]),
    );

    const result = await service.evaluate({
      userId: 'user-1',
      notificationType: type,
      channel,
      region: 'US',
      datetime: IN_QUIET_HOURS,
    });

    expect(result.decision).toBe('allow');
    expect(result.reason).not.toBe('quiet_hours');
  });
});

describe('Marketing types do NOT bypass quiet hours', () => {
  it.each([
    ['marketing_email', 'email'],
    ['marketing_sms', 'sms'],
    ['marketing_push', 'push'],
  ] as const)('%s on channel %s is blocked by quiet hours', async (type, channel) => {
    const service = buildService(
      userPrefsRepo([], QUIET_HOURS),
      globalPoliciesRepo(),
      defaultPrefsRepo([{ notificationType: type, channel, enabled: true }]),
    );

    const result = await service.evaluate({
      userId: 'user-1',
      notificationType: type,
      channel,
      region: 'US',
      datetime: IN_QUIET_HOURS,
    });

    expect(result).toEqual({ decision: 'deny', reason: 'quiet_hours' });
  });
});

describe('Global policy wildcard region (*)', () => {
  it('blocks when policy has region "*"', async () => {
    const wildcardPolicy: GlobalPolicy = {
      id: 'wildcard-1',
      notificationType: 'marketing_sms',
      channel: 'sms',
      region: '*',
      action: 'deny',
      createdAt: new Date(),
    };

    const service = buildService(
      userPrefsRepo(),
      globalPoliciesRepo(wildcardPolicy),
      defaultPrefsRepo([{ notificationType: 'marketing_sms', channel: 'sms', enabled: true }]),
    );

    const result = await service.evaluate({
      userId: 'user-1',
      notificationType: 'marketing_sms',
      channel: 'sms',
      region: 'APAC',
      datetime: OUT_OF_QUIET_HOURS,
    });

    expect(result).toEqual({ decision: 'deny', reason: 'blocked_by_global_policy' });
  });
});

describe('User preference only matches exact type+channel combination', () => {
  it('does not apply pref to a different channel', async () => {
    // User enabled marketing_email on email, but we evaluate on sms
    const service = buildService(
      userPrefsRepo([{ userId: 'user-1', notificationType: 'marketing_email', channel: 'email', enabled: true, updatedAt: new Date() }]),
      globalPoliciesRepo(),
      defaultPrefsRepo([{ notificationType: 'marketing_sms', channel: 'sms', enabled: false }]),
    );

    const result = await service.evaluate({
      userId: 'user-1',
      notificationType: 'marketing_sms',
      channel: 'sms',
      region: 'US',
      datetime: OUT_OF_QUIET_HOURS,
    });

    // No user pref for marketing_sms+sms, falls to default (disabled)
    expect(result).toEqual({ decision: 'deny', reason: 'default_preference' });
  });

  it('does not apply pref to a different notification type', async () => {
    // User enabled transactional_email, but we evaluate marketing_email
    const service = buildService(
      userPrefsRepo([{ userId: 'user-1', notificationType: 'transactional_email', channel: 'email', enabled: true, updatedAt: new Date() }]),
      globalPoliciesRepo(),
      defaultPrefsRepo([{ notificationType: 'marketing_email', channel: 'email', enabled: false }]),
    );

    const result = await service.evaluate({
      userId: 'user-1',
      notificationType: 'marketing_email',
      channel: 'email',
      region: 'US',
      datetime: OUT_OF_QUIET_HOURS,
    });

    expect(result).toEqual({ decision: 'deny', reason: 'default_preference' });
  });
});

describe('Cache behavior in EvaluationService', () => {
  it('reads from policy cache and skips DB lookup on hit', async () => {
    const globalPoliciesRepoMock = globalPoliciesRepo();

    const cache: ICache = {
      get: vi.fn().mockImplementation((key: string) => {
        if (key.startsWith('policy:')) return Promise.resolve({ blocking: false });
        if (key.startsWith('prefs:')) return Promise.resolve([]);
        if (key.startsWith('quiet:')) return Promise.resolve(false);
        return Promise.resolve(null);
      }),
      set: vi.fn().mockResolvedValue(undefined),
      del: vi.fn().mockResolvedValue(undefined),
    };

    const service = buildService(
      userPrefsRepo(),
      globalPoliciesRepoMock,
      defaultPrefsRepo([{ notificationType: 'marketing_email', channel: 'email', enabled: true }]),
      cache,
    );

    await service.evaluate({
      userId: 'user-1',
      notificationType: 'marketing_email',
      channel: 'email',
      region: 'EU',
      datetime: OUT_OF_QUIET_HOURS,
    });

    expect(globalPoliciesRepoMock.findBlocking).not.toHaveBeenCalled();
  });

  it('skips DB quiet hours lookup when cached as false', async () => {
    const userPrefsRepoMock = userPrefsRepo([], null);

    const cache: ICache = {
      get: vi.fn().mockImplementation((key: string) => {
        if (key.startsWith('policy:')) return Promise.resolve({ blocking: false });
        if (key.startsWith('prefs:')) return Promise.resolve([]);
        if (key.startsWith('quiet:')) return Promise.resolve(false); // cached: no quiet hours
        return Promise.resolve(null);
      }),
      set: vi.fn().mockResolvedValue(undefined),
      del: vi.fn().mockResolvedValue(undefined),
    };

    const service = buildService(
      userPrefsRepoMock,
      globalPoliciesRepo(),
      defaultPrefsRepo([{ notificationType: 'marketing_email', channel: 'email', enabled: true }]),
      cache,
    );

    await service.evaluate({
      userId: 'user-1',
      notificationType: 'marketing_email',
      channel: 'email',
      region: 'US',
      datetime: IN_QUIET_HOURS,
    });

    expect(userPrefsRepoMock.findQuietHours).not.toHaveBeenCalled();
  });

  it('writes to cache after DB lookup', async () => {
    const cache = noopCache();

    const service = buildService(
      userPrefsRepo([{ userId: 'user-1', notificationType: 'marketing_email', channel: 'email', enabled: true, updatedAt: new Date() }]),
      globalPoliciesRepo(),
      defaultPrefsRepo(),
      cache,
    );

    await service.evaluate({
      userId: 'user-1',
      notificationType: 'marketing_email',
      channel: 'email',
      region: 'EU',
      datetime: OUT_OF_QUIET_HOURS,
    });

    // Should have cached prefs, quiet hours, and policy
    expect(cache.set).toHaveBeenCalled();
  });
});
