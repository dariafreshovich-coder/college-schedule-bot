from __future__ import annotations

import sqlite3
from pathlib import Path


class UserStorage:
    def __init__(self, path: str | Path) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._init_db()

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.path, timeout=30)
        connection.execute("PRAGMA journal_mode=WAL")
        return connection

    def _init_db(self) -> None:
        with self._connect() as connection:
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS users (
                    user_id INTEGER PRIMARY KEY,
                    group_name TEXT,
                    notifications INTEGER NOT NULL DEFAULT 0,
                    last_notification TEXT
                )
                """
            )

    def get_group(self, user_id: int) -> str | None:
        with self._connect() as connection:
            row = connection.execute("SELECT group_name FROM users WHERE user_id = ?", (user_id,)).fetchone()
        return row[0] if row and row[0] else None

    def set_group(self, user_id: int, group_name: str) -> None:
        with self._connect() as connection:
            connection.execute(
                """
                INSERT INTO users(user_id, group_name)
                VALUES (?, ?)
                ON CONFLICT(user_id) DO UPDATE SET group_name = excluded.group_name
                """,
                (user_id, group_name),
            )

    def notifications_enabled(self, user_id: int) -> bool:
        with self._connect() as connection:
            row = connection.execute("SELECT notifications FROM users WHERE user_id = ?", (user_id,)).fetchone()
        return bool(row and row[0])

    def toggle_notifications(self, user_id: int) -> bool:
        with self._connect() as connection:
            connection.execute("INSERT OR IGNORE INTO users(user_id) VALUES (?)", (user_id,))
            connection.execute(
                "UPDATE users SET notifications = CASE notifications WHEN 0 THEN 1 ELSE 0 END WHERE user_id = ?",
                (user_id,),
            )
            row = connection.execute("SELECT notifications FROM users WHERE user_id = ?", (user_id,)).fetchone()
        return bool(row and row[0])

    def subscribers(self, notification_date: str) -> list[tuple[int, str]]:
        with self._connect() as connection:
            rows = connection.execute(
                """
                SELECT user_id, group_name
                FROM users
                WHERE notifications = 1
                  AND group_name IS NOT NULL
                  AND (last_notification IS NULL OR last_notification <> ?)
                """,
                (notification_date,),
            ).fetchall()
        return [(int(user_id), str(group_name)) for user_id, group_name in rows]

    def mark_notification(self, user_id: int, notification_date: str) -> None:
        with self._connect() as connection:
            connection.execute(
                "UPDATE users SET last_notification = ? WHERE user_id = ?",
                (notification_date, user_id),
            )

    def disable_notifications(self, user_id: int) -> None:
        with self._connect() as connection:
            connection.execute("UPDATE users SET notifications = 0 WHERE user_id = ?", (user_id,))
