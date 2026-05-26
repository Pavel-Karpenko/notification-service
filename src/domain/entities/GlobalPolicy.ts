import { Channel, NotificationType, Region } from '../types';

export interface GlobalPolicy {
  id: string;
  notificationType: NotificationType;
  channel: Channel;
  region: Region;
  action: 'allow' | 'deny';
  createdAt: Date;
}
