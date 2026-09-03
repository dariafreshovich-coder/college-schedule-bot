CREATE TABLE IF NOT EXISTS users (
  telegram_id TEXT PRIMARY KEY,
  group_name TEXT,
  notifications INTEGER NOT NULL DEFAULT 0,
  last_notification TEXT
);

CREATE TABLE IF NOT EXISTS schedule_change_notifications (
  change_key TEXT PRIMARY KEY,
  change_date TEXT NOT NULL,
  group_name TEXT NOT NULL,
  pair TEXT NOT NULL,
  payload TEXT NOT NULL,
  detected_at TEXT NOT NULL,
  sent_at TEXT
);

CREATE TABLE IF NOT EXISTS schedule_notification_state (
  id INTEGER PRIMARY KEY,
  initialized INTEGER NOT NULL DEFAULT 0
);
