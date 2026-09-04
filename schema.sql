CREATE TABLE IF NOT EXISTS users (
  telegram_id TEXT PRIMARY KEY,
  group_name TEXT,
  notifications INTEGER NOT NULL DEFAULT 0,
  last_notification TEXT,
  schedule_message_id TEXT,
  schedule_offset INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS schedule_event_baseline (
  snapshot_key TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  change_date TEXT,
  weekday TEXT,
  group_name TEXT NOT NULL,
  pair TEXT NOT NULL,
  payload TEXT NOT NULL,
  source_updated_at TEXT
);

CREATE TABLE IF NOT EXISTS schedule_event_notifications (
  event_key TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  change_date TEXT,
  weekday TEXT,
  group_name TEXT NOT NULL,
  pair TEXT NOT NULL,
  payload TEXT,
  previous_payload TEXT,
  detected_at TEXT NOT NULL,
  source_updated_at TEXT,
  sent_at TEXT
);

CREATE TABLE IF NOT EXISTS schedule_event_state (
  id INTEGER PRIMARY KEY,
  initialized INTEGER NOT NULL DEFAULT 0
);
