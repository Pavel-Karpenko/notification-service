import { IUserPreferenceRepository } from '../../domain/repositories/IUserPreferenceRepository';
import { IDefaultPreferenceRepository } from '../../domain/repositories/IDefaultPreferenceRepository';
import { ICache } from '../../infrastructure/cache/RedisCache';
import { NOTIFICATION_TYPES, CHANNELS, NotificationType, Channel } from '../../domain/types';
import { QuietHours } from '../../domain/entities/QuietHours';

export interface PreferenceWithSource {
  notificationType: NotificationType;
  channel: Channel;
  enabled: boolean;
  source: 'user' | 'default';
}

export interface GetUserPreferencesResult {
  userId: string;
  preferences: PreferenceWithSource[];
  quietHours: Omit<QuietHours, 'userId' | 'updatedAt'> | null;
}

export class GetUserPreferences {
  constructor(
    private readonly userPrefs: IUserPreferenceRepository,
    private readonly defaultPrefs: IDefaultPreferenceRepository,
    private readonly cache: ICache,
  ) {}

  async execute(userId: string): Promise<GetUserPreferencesResult> {
    // Try cache first for user preferences
    const cacheKey = `prefs:${userId}`;
    const cachedPrefs = await this.cache.get<Array<{
      notificationType: string;
      channel: string;
      enabled: boolean;
    }>>(cacheKey);

    let userPrefsMap: Map<string, boolean>;

    if (cachedPrefs !== null) {
      userPrefsMap = new Map(
        cachedPrefs.map((p) => [`${p.notificationType}:${p.channel}`, p.enabled]),
      );
    } else {
      const userPrefsList = await this.userPrefs.findByUserId(userId);
      userPrefsMap = new Map(
        userPrefsList.map((p) => [`${p.notificationType}:${p.channel}`, p.enabled]),
      );
      await this.cache.set(
        cacheKey,
        userPrefsList.map((p) => ({
          notificationType: p.notificationType,
          channel: p.channel,
          enabled: p.enabled,
        })),
        60,
      );
    }

    // Load all defaults
    const defaults = await this.defaultPrefs.findAll();
    const defaultsMap = new Map(
      defaults.map((d) => [`${d.notificationType}:${d.channel}`, d.enabled]),
    );

    // Build merged preference list: iterate all known type+channel combinations
    const preferences: PreferenceWithSource[] = [];

    for (const notificationType of NOTIFICATION_TYPES) {
      for (const channel of CHANNELS) {
        const key = `${notificationType}:${channel}`;
        const userEnabled = userPrefsMap.get(key);
        const defaultEnabled = defaultsMap.get(key);

        // Only include combinations that exist in defaults or user prefs
        if (userEnabled !== undefined) {
          preferences.push({
            notificationType,
            channel,
            enabled: userEnabled,
            source: 'user',
          });
        } else if (defaultEnabled !== undefined) {
          preferences.push({
            notificationType,
            channel,
            enabled: defaultEnabled,
            source: 'default',
          });
        }
      }
    }

    // Quiet hours
    const quietCacheKey = `quiet:${userId}`;
    const cachedQuiet = await this.cache.get<{
      startHour: number;
      startMinute: number;
      endHour: number;
      endMinute: number;
      timezone: string;
    } | false>(quietCacheKey);

    let quietHours: Omit<QuietHours, 'userId' | 'updatedAt'> | null = null;

    if (cachedQuiet !== null) {
      if (cachedQuiet !== false) {
        quietHours = cachedQuiet;
      }
    } else {
      const qh = await this.userPrefs.findQuietHours(userId);
      if (qh) {
        quietHours = {
          startHour: qh.startHour,
          startMinute: qh.startMinute,
          endHour: qh.endHour,
          endMinute: qh.endMinute,
          timezone: qh.timezone,
        };
        await this.cache.set(quietCacheKey, quietHours, 60);
      } else {
        await this.cache.set(quietCacheKey, false, 60);
      }
    }

    return { userId, preferences, quietHours };
  }
}
