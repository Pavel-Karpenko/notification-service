export const NOTIFICATION_TYPES = [
  'transactional_email',
  'marketing_email',
  'transactional_sms',
  'marketing_sms',
  'transactional_push',
  'marketing_push',
] as const;

export type NotificationType = typeof NOTIFICATION_TYPES[number];

export const CHANNELS = ['email', 'sms', 'push', 'messenger'] as const;
export type Channel = typeof CHANNELS[number];

export const REGIONS = ['EU', 'US', 'APAC', 'LATAM', 'OTHER'] as const;
export type Region = string;

export type Decision = 'allow' | 'deny';

export type DenyReason =
  | 'blocked_by_global_policy'
  | 'disabled_by_user'
  | 'quiet_hours'
  | 'default_preference';

export type AllowReason = 'user_preference' | 'default_preference';

export type EvaluateResult =
  | { decision: 'allow'; reason: AllowReason }
  | { decision: 'deny'; reason: DenyReason };

export function isTransactional(type: NotificationType): boolean {
  return type.startsWith('transactional_');
}
