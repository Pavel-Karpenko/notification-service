import { Channel, NotificationType } from '../types';
import { DefaultPreference } from '../entities/DefaultPreference';

export interface IDefaultPreferenceRepository {
  findAll(): Promise<DefaultPreference[]>;
  findOne(type: NotificationType, channel: Channel): Promise<DefaultPreference | null>;
}
