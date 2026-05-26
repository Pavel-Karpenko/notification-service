CREATE TABLE IF NOT EXISTS default_preferences (
  notification_type TEXT NOT NULL,
  channel TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT true,
  UNIQUE(notification_type, channel)
);

CREATE TABLE IF NOT EXISTS user_preferences (
  user_id TEXT NOT NULL,
  notification_type TEXT NOT NULL,
  channel TEXT NOT NULL,
  enabled BOOLEAN NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, notification_type, channel)
);

CREATE TABLE IF NOT EXISTS quiet_hours (
  user_id TEXT PRIMARY KEY,
  start_hour INTEGER NOT NULL,
  start_minute INTEGER NOT NULL DEFAULT 0,
  end_hour INTEGER NOT NULL,
  end_minute INTEGER NOT NULL DEFAULT 0,
  timezone TEXT NOT NULL DEFAULT 'UTC',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS global_policies (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  notification_type TEXT NOT NULL,
  channel TEXT NOT NULL,
  region TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('allow', 'deny')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(notification_type, channel, region)
);

-- Seed default preferences
INSERT INTO default_preferences (notification_type, channel, enabled) VALUES
  ('transactional_email', 'email', true),
  ('marketing_email', 'email', false),
  ('transactional_sms', 'sms', true),
  ('marketing_sms', 'sms', false),
  ('transactional_push', 'push', true),
  ('marketing_push', 'push', false)
ON CONFLICT DO NOTHING;
