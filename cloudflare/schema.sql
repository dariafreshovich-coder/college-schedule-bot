CREATE TABLE IF NOT EXISTS users (
  telegram_id TEXT PRIMARY KEY,
  group_name TEXT,
  notifications INTEGER NOT NULL DEFAULT 0,
  last_notification TEXT
);
