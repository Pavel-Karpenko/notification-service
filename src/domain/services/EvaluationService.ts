import { Channel, EvaluateResult, NotificationType, isTransactional } from '../types';
import { IUserPreferenceRepository } from '../repositories/IUserPreferenceRepository';
import { IGlobalPolicyRepository } from '../repositories/IGlobalPolicyRepository';
import { IDefaultPreferenceRepository } from '../repositories/IDefaultPreferenceRepository';
import { isInQuietHours } from '../entities/QuietHours';
import { ICache } from '../../infrastructure/cache/RedisCache';

export class EvaluationService {
  constructor(
    private readonly userPrefs: IUserPreferenceRepository,
    private readonly globalPolicies: IGlobalPolicyRepository,
    private readonly defaultPrefs: IDefaultPreferenceRepository,
    private readonly cache: ICache,
  ) {}

  async evaluate(input: {
    userId: string;
    notificationType: NotificationType;
    channel: Channel;
    region: string;
    datetime: Date;
  }): Promise<EvaluateResult> {
    // 1. Global policy check
    const policy = await this.getBlockingPolicy(input.notificationType, input.channel, input.region);
    if (policy) return { decision: 'deny', reason: 'blocked_by_global_policy' };

    // 2. User explicit preference
    const userPref = await this.getUserPref(input.userId, input.notificationType, input.channel);
    if (userPref?.enabled === false) return { decision: 'deny', reason: 'disabled_by_user' };

    // 3. Quiet hours (skip for transactional)
    if (!isTransactional(input.notificationType)) {
      const qh = await this.getQuietHours(input.userId);
      if (qh && isInQuietHours(input.datetime, qh)) {
        return { decision: 'deny', reason: 'quiet_hours' };
      }
    }

    // 4. User explicitly enabled
    if (userPref?.enabled === true) return { decision: 'allow', reason: 'user_preference' };

    // 5. Default
    const defaultPref = await this.getDefaultPref(input.notificationType, input.channel);
    return defaultPref?.enabled
      ? { decision: 'allow', reason: 'default_preference' }
      : { decision: 'deny', reason: 'default_preference' };
  }

  private async getBlockingPolicy(
    type: NotificationType,
    channel: Channel,
    region: string,
  ) {
    const cacheKey = `policy:${type}:${channel}:${region}`;
    const cached = await this.cache.get<{ blocking: boolean }>(cacheKey);
    if (cached !== null) {
      // We store whether there's a blocking policy; if blocking === true, return a sentinel truthy value
      return cached.blocking ? true : null;
    }

    const policy = await this.globalPolicies.findBlocking(type, channel, region);
    await this.cache.set(cacheKey, { blocking: policy !== null }, 300);
    return policy;
  }

  private async getUserPref(userId: string, type: NotificationType, channel: Channel) {
    const cacheKey = `prefs:${userId}`;
    const cached = await this.cache.get<Array<{ notificationType: string; channel: string; enabled: boolean }>>(cacheKey);
    if (cached !== null) {
      const found = cached.find(
        (p) => p.notificationType === type && p.channel === channel,
      );
      return found ?? null;
    }

    // Load all user prefs and cache them
    const prefs = await this.userPrefs.findByUserId(userId);
    const serializable = prefs.map((p) => ({
      notificationType: p.notificationType,
      channel: p.channel,
      enabled: p.enabled,
    }));
    await this.cache.set(cacheKey, serializable, 60);

    return prefs.find((p) => p.notificationType === type && p.channel === channel) ?? null;
  }

  private async getQuietHours(userId: string) {
    const cacheKey = `quiet:${userId}`;
    const cached = await this.cache.get<{
      startHour: number;
      startMinute: number;
      endHour: number;
      endMinute: number;
      timezone: string;
    } | false>(cacheKey);

    if (cached !== null) {
      if (cached === false) return null;
      return {
        userId,
        startHour: cached.startHour,
        startMinute: cached.startMinute,
        endHour: cached.endHour,
        endMinute: cached.endMinute,
        timezone: cached.timezone,
        updatedAt: new Date(),
      };
    }

    const qh = await this.userPrefs.findQuietHours(userId);
    if (qh) {
      await this.cache.set(cacheKey, {
        startHour: qh.startHour,
        startMinute: qh.startMinute,
        endHour: qh.endHour,
        endMinute: qh.endMinute,
        timezone: qh.timezone,
      }, 60);
    } else {
      await this.cache.set(cacheKey, false, 60);
    }
    return qh;
  }

  private async getDefaultPref(type: NotificationType, channel: Channel) {
    return this.defaultPrefs.findOne(type, channel);
  }
}
