import { IUserPreferenceRepository } from '../../domain/repositories/IUserPreferenceRepository';
import { ICache } from '../../infrastructure/cache/RedisCache';
import { UserPreference } from '../../domain/entities/UserPreference';
import { QuietHours } from '../../domain/entities/QuietHours';
import { preferenceUpdatesTotal } from '../../infrastructure/metrics/prometheus';

export interface UpdatePreferenceInput {
  notificationType: UserPreference['notificationType'];
  channel: UserPreference['channel'];
  enabled: boolean;
}

export interface UpdateQuietHoursInput {
  startHour: number;
  startMinute: number;
  endHour: number;
  endMinute: number;
  timezone: string;
}

export interface UpdateUserPreferencesInput {
  userId: string;
  preferences?: UpdatePreferenceInput[];
  quietHours?: UpdateQuietHoursInput;
}

export interface UpdateUserPreferencesResult {
  updatedPreferences: UserPreference[];
  quietHours: Omit<QuietHours, 'userId' | 'updatedAt'> | null;
}

export class UpdateUserPreferences {
  constructor(
    private readonly userPrefs: IUserPreferenceRepository,
    private readonly cache: ICache,
  ) {}

  async execute(input: UpdateUserPreferencesInput): Promise<UpdateUserPreferencesResult> {
    const updatedPreferences: UserPreference[] = [];

    if (input.preferences) {
      for (const pref of input.preferences) {
        const updated = await this.userPrefs.upsert({
          userId: input.userId,
          notificationType: pref.notificationType,
          channel: pref.channel,
          enabled: pref.enabled,
        });
        updatedPreferences.push(updated);
        preferenceUpdatesTotal.inc({
          notification_type: pref.notificationType,
          channel: pref.channel,
        });
      }
    }

    let quietHoursResult: Omit<QuietHours, 'userId' | 'updatedAt'> | null = null;

    if (input.quietHours) {
      const saved = await this.userPrefs.upsertQuietHours({
        userId: input.userId,
        startHour: input.quietHours.startHour,
        startMinute: input.quietHours.startMinute,
        endHour: input.quietHours.endHour,
        endMinute: input.quietHours.endMinute,
        timezone: input.quietHours.timezone,
      });
      quietHoursResult = {
        startHour: saved.startHour,
        startMinute: saved.startMinute,
        endHour: saved.endHour,
        endMinute: saved.endMinute,
        timezone: saved.timezone,
      };
    }

    // Invalidate cache for this user
    await this.cache.del(`prefs:${input.userId}`);
    await this.cache.del(`quiet:${input.userId}`);

    return {
      updatedPreferences,
      quietHours: quietHoursResult,
    };
  }
}
