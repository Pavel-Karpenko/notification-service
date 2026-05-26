import { Channel, NotificationType } from '../types';
import { GlobalPolicy } from '../entities/GlobalPolicy';

export interface IGlobalPolicyRepository {
  findBlocking(type: NotificationType, channel: Channel, region: string): Promise<GlobalPolicy | null>;
  findAll(): Promise<GlobalPolicy[]>;
  upsert(policy: Omit<GlobalPolicy, 'id' | 'createdAt'>): Promise<GlobalPolicy>;
}
