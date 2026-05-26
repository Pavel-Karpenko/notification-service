import { Channel, NotificationType } from '../types';

export interface UserPreference {
  userId: string;
  notificationType: NotificationType;
  channel: Channel;
  enabled: boolean;
  updatedAt: Date;
}
