import { pgTable, text, boolean, integer, timestamp, unique } from 'drizzle-orm/pg-core';

export const defaultPreferences = pgTable('default_preferences', {
  notificationType: text('notification_type').notNull(),
  channel: text('channel').notNull(),
  enabled: boolean('enabled').notNull().default(true),
}, (t) => ({
  pk: unique().on(t.notificationType, t.channel),
}));

export const userPreferences = pgTable('user_preferences', {
  userId: text('user_id').notNull(),
  notificationType: text('notification_type').notNull(),
  channel: text('channel').notNull(),
  enabled: boolean('enabled').notNull(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
}, (t) => ({
  pk: unique().on(t.userId, t.notificationType, t.channel),
}));

export const quietHours = pgTable('quiet_hours', {
  userId: text('user_id').primaryKey(),
  startHour: integer('start_hour').notNull(),
  startMinute: integer('start_minute').notNull().default(0),
  endHour: integer('end_hour').notNull(),
  endMinute: integer('end_minute').notNull().default(0),
  timezone: text('timezone').notNull().default('UTC'),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

export const globalPolicies = pgTable('global_policies', {
  id: text('id').primaryKey(),
  notificationType: text('notification_type').notNull(),
  channel: text('channel').notNull(),
  region: text('region').notNull(),
  action: text('action').notNull(), // 'allow' | 'deny'
  createdAt: timestamp('created_at').notNull().defaultNow(),
}, (t) => ({
  uniq: unique().on(t.notificationType, t.channel, t.region),
}));
