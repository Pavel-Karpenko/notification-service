import { Channel, NotificationType } from '../types';

export interface DefaultPreference {
  notificationType: NotificationType;
  channel: Channel;
  enabled: boolean;
}
