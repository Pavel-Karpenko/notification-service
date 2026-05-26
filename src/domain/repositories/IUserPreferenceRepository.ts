import { Channel, NotificationType } from '../types';
import { UserPreference } from '../entities/UserPreference';
import { QuietHours } from '../entities/QuietHours';

export interface IUserPreferenceRepository {
  findByUserId(userId: string): Promise<UserPreference[]>;
  findOne(userId: string, type: NotificationType, channel: Channel): Promise<UserPreference | null>;
  upsert(pref: Omit<UserPreference, 'updatedAt'>): Promise<UserPreference>;
  findQuietHours(userId: string): Promise<QuietHours | null>;
  upsertQuietHours(qh: Omit<QuietHours, 'updatedAt'>): Promise<QuietHours>;
}
